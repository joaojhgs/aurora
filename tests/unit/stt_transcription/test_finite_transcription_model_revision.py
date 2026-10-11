"""Finite STT model-revision ABA regressions."""

from __future__ import annotations

import asyncio
import base64
import io
import threading
import wave
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest

from app.services.stt_transcription.service import TranscriptionService
from app.shared.contracts.models.stt import STTControl, TranscribeAudioRequest


def _service_with_models() -> tuple[TranscriptionService, MagicMock, MagicMock]:
    bus = Mock()
    bus.publish = AsyncMock()
    realtime = MagicMock()
    accurate = MagicMock()
    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        service = TranscriptionService()
    service._bus = bus
    service._realtime_enabled = True
    service._accurate_enabled = True
    service._realtime_model = realtime
    service._accurate_model = accurate
    service._model_status_message = {"realtime": "model_ready", "accurate": "model_ready"}
    return service, realtime, accurate


def _audio_request(audio_format: str = "raw", model: str = "realtime") -> TranscribeAudioRequest:
    pcm = b"\x01\x00" * 16000
    if audio_format == "wav":
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(16000)
            wav_file.writeframes(pcm)
        pcm = buffer.getvalue()
    return TranscribeAudioRequest(
        audio_data=base64.b64encode(pcm).decode("ascii"),
        format=audio_format,
        sample_rate=16000,
        channels=1,
        model=model,
    )


async def _wait_for_worker_entry(entry: threading.Event, release: threading.Event) -> None:
    try:
        assert await asyncio.to_thread(entry.wait, 2.0), (
            "inference never entered the controlled model"
        )
    except BaseException:
        release.set()
        raise


@pytest.mark.parametrize("model_name", ["realtime", "accurate"])
@pytest.mark.asyncio
async def test_enable_selected_model_false_then_true_retires_inflight_result(
    model_name: str,
) -> None:
    service, realtime, accurate = _service_with_models()
    selected_model = accurate if model_name == "accurate" else realtime
    enabled_attribute = f"_{model_name}_enabled"
    model_attribute = f"_{model_name}_model"
    entered = threading.Event()
    release = threading.Event()
    worker_finished = threading.Event()

    def transcribe(*_args, **_kwargs):
        entered.set()
        try:
            release.wait(timeout=4.0)
            return [SimpleNamespace(text="stale result")], SimpleNamespace(language="en")
        finally:
            worker_finished.set()

    selected_model.transcribe.side_effect = transcribe
    request = _audio_request(model=model_name)
    task = asyncio.create_task(service.transcribe_audio(request))
    try:
        await _wait_for_worker_entry(entered, release)
        original_generation = service._runtime_generation
        action = f"enable_{model_name}"
        await service._on_control(STTControl(action=action, enabled=False))
        await service._on_control(STTControl(action=action, enabled=True))
        assert getattr(service, enabled_attribute) is True
        assert getattr(service, model_attribute) is selected_model
        assert service._runtime_generation == original_generation

        release.set()
        with pytest.raises(RuntimeError, match="^Transcription failed$"):
            await task
    finally:
        release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.to_thread(worker_finished.wait, 2.0)

    selected_model.transcribe.assert_called_once()


@pytest.mark.asyncio
async def test_reload_a_to_b_to_a_retires_inflight_model_result() -> None:
    service, realtime, accurate = _service_with_models()
    replacement = MagicMock()
    entered = threading.Event()
    release = threading.Event()
    worker_finished = threading.Event()

    def transcribe(*_args, **_kwargs):
        entered.set()
        try:
            release.wait(timeout=4.0)
            return [SimpleNamespace(text="stale result")], SimpleNamespace(language="en")
        finally:
            worker_finished.set()

    realtime.transcribe.side_effect = transcribe
    config = {"max_speech_duration_s": 30}
    service._read_runtime_config = AsyncMock(
        return_value=("en", service._language_policy, config, True, True)
    )
    service._create_models = AsyncMock(side_effect=[(replacement, accurate), (realtime, accurate)])
    request = _audio_request()
    task = asyncio.create_task(service.transcribe_audio(request))
    try:
        await _wait_for_worker_entry(entered, release)
        original_generation = service._runtime_generation
        await service.reload("services.stt")
        assert service._realtime_model is replacement
        await service.reload("services.stt")
        assert service._realtime_model is realtime
        assert service._realtime_enabled is True
        assert service._runtime_generation == original_generation
        assert service._read_runtime_config.await_count == 2
        assert service._create_models.await_count == 2

        release.set()
        with pytest.raises(RuntimeError, match="^Transcription failed$"):
            await task
    finally:
        release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.to_thread(worker_finished.wait, 2.0)

    realtime.transcribe.assert_called_once()


@pytest.mark.parametrize("model_name", ["realtime", "accurate"])
@pytest.mark.asyncio
async def test_held_failed_reload_retires_inflight_result_but_keeps_model_usable(
    model_name: str,
) -> None:
    service, realtime, accurate = _service_with_models()
    selected_model = accurate if model_name == "accurate" else realtime
    entered = threading.Event()
    release_inference = threading.Event()
    worker_finished = threading.Event()
    call_count = 0

    def transcribe(*_args, **_kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            entered.set()
            try:
                release_inference.wait(timeout=4.0)
                return [SimpleNamespace(text="stale result")], SimpleNamespace(language="en")
            finally:
                worker_finished.set()
        return [SimpleNamespace(text="retained model result")], SimpleNamespace(language="en")

    selected_model.transcribe.side_effect = transcribe
    config_read_entered = asyncio.Event()
    release_config_read = asyncio.Event()

    async def fail_held_config_read():
        config_read_entered.set()
        await release_config_read.wait()
        raise RuntimeError("configuration temporarily unavailable")

    service._read_runtime_config = AsyncMock(side_effect=fail_held_config_read)
    request = _audio_request(model=model_name)
    inference_task = asyncio.create_task(service.transcribe_audio(request))
    reload_task: asyncio.Task[None] | None = None
    try:
        await _wait_for_worker_entry(entered, release_inference)
        reload_task = asyncio.create_task(service.reload("services.stt"))
        await asyncio.wait_for(config_read_entered.wait(), timeout=2.0)

        # A config read is still pending: starting the reload must already
        # retire the old request even though this reload will fail.
        release_inference.set()
        with pytest.raises(RuntimeError, match="^Transcription failed$"):
            await inference_task
        assert getattr(service, f"_{model_name}_model") is selected_model
        assert getattr(service, f"_{model_name}_enabled") is True

        release_config_read.set()
        with pytest.raises(RuntimeError, match="configuration temporarily unavailable"):
            await reload_task

        later_result = await service.transcribe_audio(request)
        assert later_result.text == "retained model result"
        assert later_result.model_used == model_name
        assert call_count == 2
    finally:
        release_inference.set()
        release_config_read.set()
        for task in (inference_task, reload_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (inference_task, reload_task) if task is not None),
            return_exceptions=True,
        )
        await asyncio.to_thread(worker_finished.wait, 2.0)


@pytest.mark.parametrize("model_name", ["realtime", "accurate"])
@pytest.mark.asyncio
async def test_noop_enable_control_does_not_retire_inflight_result(model_name: str) -> None:
    service, realtime, accurate = _service_with_models()
    selected_model = accurate if model_name == "accurate" else realtime
    entered = threading.Event()
    release = threading.Event()
    worker_finished = threading.Event()

    def transcribe(*_args, **_kwargs):
        entered.set()
        try:
            release.wait(timeout=4.0)
            return [SimpleNamespace(text="current result")], SimpleNamespace(language="en")
        finally:
            worker_finished.set()

    selected_model.transcribe.side_effect = transcribe
    task = asyncio.create_task(service.transcribe_audio(_audio_request(model=model_name)))
    try:
        await _wait_for_worker_entry(entered, release)
        original_generation = service._runtime_generation
        await service._on_control(STTControl(action=f"enable_{model_name}", enabled=True))
        assert getattr(service, f"_{model_name}_model") is selected_model
        assert getattr(service, f"_{model_name}_enabled") is True
        assert service._runtime_generation == original_generation
        release.set()
        result = await task
    finally:
        release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.to_thread(worker_finished.wait, 2.0)

    assert result.text == "current result"
    selected_model.transcribe.assert_called_once()
    assert realtime.transcribe.call_count + accurate.transcribe.call_count == 1


@pytest.mark.asyncio
async def test_stale_config_read_cannot_clobber_newer_reload_state_or_readiness(
    monkeypatch, tmp_path
) -> None:
    service, realtime, accurate = _service_with_models()
    older_config_entered = asyncio.Event()
    release_older_config = asyncio.Event()
    read_count = 0
    policy = service._language_policy
    newer_config = {
        "max_speech_duration_s": 22,
        "realtime_model": {"enabled": True, "model_size": "new-realtime", "device": "cpu"},
        "accurate_model": {"enabled": False, "model_size": None, "device": "cpu"},
    }
    older_config = {
        "max_speech_duration_s": 11,
        "realtime_model": {"enabled": True, "model_size": "old-realtime", "device": "cpu"},
        "accurate_model": {"enabled": True, "model_size": "old-accurate", "device": "cpu"},
    }

    async def read_config_by_invocation_order():
        nonlocal read_count
        read_count += 1
        if read_count == 1:
            older_config_entered.set()
            await release_older_config.wait()
            return "fr", policy, older_config, True, True
        return "de", policy, newer_config, True, False

    service._read_runtime_config = AsyncMock(side_effect=read_config_by_invocation_order)
    new_model = MagicMock(name="new-realtime-model")
    stale_model = MagicMock(name="old-realtime-model")
    stale_accurate_model = MagicMock(name="old-accurate-model")
    constructor = Mock(side_effect=[new_model, stale_model, stale_accurate_model])
    monkeypatch.setattr(
        "app.services.stt_transcription.service._create_whisper_model",
        constructor,
    )
    monkeypatch.setattr(
        "app.services.stt_transcription.service.get_use_hardware_acceleration",
        Mock(return_value="cpu"),
    )
    monkeypatch.setattr(
        "app.services.stt_transcription.service.ensure_path_writable_or_tmp",
        lambda path, **_kwargs: str(path),
    )
    monkeypatch.delenv("HF_HOME", raising=False)
    monkeypatch.delenv("AURORA_STT_WHISPER_DOWNLOAD_ROOT", raising=False)
    service._default_app_data_cache_dir = Mock(
        side_effect=[str(tmp_path / "new-cache"), str(tmp_path / "old-cache")]
    )
    original_create_models = service._create_models
    create_models = AsyncMock(wraps=original_create_models)
    service._create_models = create_models
    original_load_one_model = service._load_one_model
    load_one_model = Mock(wraps=original_load_one_model)
    service._load_one_model = load_one_model

    older_reload = asyncio.create_task(service.reload("services.stt"))
    newer_reload: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(older_config_entered.wait(), timeout=2.0)
        newer_reload = asyncio.create_task(service.reload("services.stt"))
        await newer_reload

        assert service._language == "de"
        assert service._realtime_enabled is True
        assert service._accurate_enabled is False
        assert service._max_speech_duration_s == 22
        assert service._realtime_model is new_model
        assert service._accurate_model is None
        assert service._model_status_message["accurate"] == "disabled"
        assert service._model_cache_dir.endswith("new-cache/whisper")
        assert constructor.call_count == 1
        assert create_models.await_count == 1
        assert load_one_model.call_count == 2

        release_older_config.set()
        await older_reload

        assert service._language == "de"
        assert service._realtime_enabled is True
        assert service._accurate_enabled is False
        assert service._max_speech_duration_s == 22
        assert service._realtime_model is new_model
        assert service._accurate_model is None
        assert service._model_status_message["accurate"] == "disabled"
        assert service._model_cache_dir.endswith("new-cache/whisper")
        assert constructor.call_count == 1
        assert create_models.await_count == 1
        assert load_one_model.call_count == 2
    finally:
        release_older_config.set()
        for task in (older_reload, newer_reload):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (older_reload, newer_reload) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_older_reload_read_is_discarded_after_newer_reload_fails() -> None:
    service, realtime, accurate = _service_with_models()
    initial_state = (
        service._language,
        service._language_policy,
        service._realtime_enabled,
        service._accurate_enabled,
        service._max_speech_duration_s,
        service._realtime_model,
        service._accurate_model,
        dict(service._model_status),
        dict(service._model_status_message),
        service._model_cache_dir,
    )
    older_read_entered = asyncio.Event()
    release_older_read = asyncio.Event()
    read_count = 0

    async def read_ordered_config():
        nonlocal read_count
        read_count += 1
        if read_count == 1:
            older_read_entered.set()
            await release_older_read.wait()
            return (
                "fr",
                service._language_policy,
                {"max_speech_duration_s": 11},
                False,
                False,
            )
        raise RuntimeError("newer configuration read failed")

    service._read_runtime_config = AsyncMock(side_effect=read_ordered_config)
    service._create_models = AsyncMock(return_value=(MagicMock(), MagicMock()))
    older_reload = asyncio.create_task(service.reload("services.stt"))
    newer_reload: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(older_read_entered.wait(), timeout=2.0)
        newer_reload = asyncio.create_task(service.reload("services.stt"))
        with pytest.raises(RuntimeError, match="newer configuration read failed"):
            await newer_reload

        release_older_read.set()
        await older_reload

        assert service._create_models.await_count == 0
        assert (
            service._language,
            service._language_policy,
            service._realtime_enabled,
            service._accurate_enabled,
            service._max_speech_duration_s,
            service._realtime_model,
            service._accurate_model,
            dict(service._model_status),
            dict(service._model_status_message),
            service._model_cache_dir,
        ) == initial_state
        assert service._realtime_model is realtime
        assert service._accurate_model is accurate
    finally:
        release_older_read.set()
        for task in (older_reload, newer_reload):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (older_reload, newer_reload) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_deactivation_discards_pending_reload_before_model_construction() -> None:
    service, realtime, accurate = _service_with_models()
    replacement = MagicMock()
    initial_language = service._language
    config_read_entered = asyncio.Event()
    release_config_read = asyncio.Event()

    async def read_held_config():
        config_read_entered.set()
        await release_config_read.wait()
        return (
            "fr",
            service._language_policy,
            {"max_speech_duration_s": 11},
            True,
            True,
        )

    service._runtime_state = "active"
    service._started = True
    service._read_runtime_config = AsyncMock(side_effect=read_held_config)
    service._create_models = AsyncMock(return_value=(replacement, accurate))
    service._stop_gateway_announcement_loop = Mock()
    service._publish_service_departure = AsyncMock()
    service._unsubscribe_registered_contracts = Mock()
    service.on_deactivate = AsyncMock()
    service._subscribe_registered_contracts = AsyncMock()

    reload_task = asyncio.create_task(service.reload("services.stt"))
    try:
        await asyncio.wait_for(config_read_entered.wait(), timeout=2.0)
        await service.deactivate(reason="test-retirement")
        assert service._runtime_state == "inactive"

        release_config_read.set()
        await reload_task

        assert service._create_models.await_count == 0
        assert service._realtime_model is realtime
        assert service._accurate_model is accurate
        assert service._language == initial_language
    finally:
        release_config_read.set()
        if not reload_task.done():
            reload_task.cancel()
        await asyncio.gather(reload_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_irrelevant_reload_does_not_advance_model_revision_or_reload_config() -> None:
    service, realtime, accurate = _service_with_models()
    service._read_runtime_config = AsyncMock()
    service._create_models = AsyncMock()
    initial_revision = getattr(service, "_model_revision", 0)
    initial_state = (
        service._language,
        service._language_policy,
        service._realtime_enabled,
        service._accurate_enabled,
        service._max_speech_duration_s,
        service._realtime_model,
        service._accurate_model,
        dict(service._model_status),
        dict(service._model_status_message),
        service._model_cache_dir,
    )

    await service.reload("services.gateway")

    assert service._read_runtime_config.await_count == 0
    assert service._create_models.await_count == 0
    assert getattr(service, "_model_revision", 0) == initial_revision
    assert (
        service._language,
        service._language_policy,
        service._realtime_enabled,
        service._accurate_enabled,
        service._max_speech_duration_s,
        service._realtime_model,
        service._accurate_model,
        dict(service._model_status),
        dict(service._model_status_message),
        service._model_cache_dir,
    ) == initial_state
    assert service._realtime_model is realtime
    assert service._accurate_model is accurate


@pytest.mark.parametrize("model_name", ["realtime", "accurate"])
@pytest.mark.asyncio
async def test_reload_commit_retires_call_started_during_held_config_read(
    model_name: str,
) -> None:
    service, realtime, accurate = _service_with_models()
    selected_model = accurate if model_name == "accurate" else realtime
    config_read_entered = asyncio.Event()
    release_config_read = asyncio.Event()
    inference_entered = threading.Event()
    release_inference = threading.Event()
    worker_finished = threading.Event()

    async def read_held_config():
        config_read_entered.set()
        await release_config_read.wait()
        return (
            "en",
            service._language_policy,
            {"max_speech_duration_s": 30},
            True,
            True,
        )

    def transcribe(*_args, **_kwargs):
        inference_entered.set()
        try:
            release_inference.wait(timeout=4.0)
            return [SimpleNamespace(text="retired during reload")], SimpleNamespace(language="en")
        finally:
            worker_finished.set()

    selected_model.transcribe.side_effect = transcribe
    service._read_runtime_config = AsyncMock(side_effect=read_held_config)
    service._create_models = AsyncMock(return_value=(realtime, accurate))
    reload_task = asyncio.create_task(service.reload("services.stt"))
    inference_task: asyncio.Task | None = None
    try:
        await asyncio.wait_for(config_read_entered.wait(), timeout=2.0)
        inference_task = asyncio.create_task(
            service.transcribe_audio(_audio_request(model=model_name))
        )
        await _wait_for_worker_entry(inference_entered, release_inference)

        release_config_read.set()
        await reload_task
        assert getattr(service, f"_{model_name}_model") is selected_model
        assert getattr(service, f"_{model_name}_enabled") is True

        # The revision at request start matches the held reload's begin token,
        # but a successful commit must retire work admitted during that read.
        release_inference.set()
        with pytest.raises(RuntimeError, match="^Transcription failed$"):
            await inference_task
    finally:
        release_config_read.set()
        release_inference.set()
        for task in (reload_task, inference_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (reload_task, inference_task) if task is not None),
            return_exceptions=True,
        )
        await asyncio.to_thread(worker_finished.wait, 2.0)

    selected_model.transcribe.assert_called_once()


@pytest.mark.parametrize("model_name", ["realtime", "accurate"])
@pytest.mark.asyncio
async def test_toggle_while_call_waits_for_model_lock_prevents_engine_entry(
    model_name: str,
) -> None:
    service, realtime, accurate = _service_with_models()
    selected_model = accurate if model_name == "accurate" else realtime
    lock_owned = threading.Lock()
    lock_owned.acquire()
    lock_waiting = threading.Event()
    worker_finished = threading.Event()

    class ObservedModelLock:
        def __enter__(self):
            lock_waiting.set()
            lock_owned.acquire()
            return self

        def __exit__(self, *_exc_info):
            lock_owned.release()
            worker_finished.set()

    service._model_lock = ObservedModelLock()
    task = asyncio.create_task(service.transcribe_audio(_audio_request(model=model_name)))
    try:
        assert await asyncio.to_thread(lock_waiting.wait, 2.0), (
            "finite worker did not reach the held model lock"
        )
        await service._on_control(STTControl(action=f"enable_{model_name}", enabled=False))
        await service._on_control(STTControl(action=f"enable_{model_name}", enabled=True))
        assert getattr(service, f"_{model_name}_enabled") is True

        lock_owned.release()
        with pytest.raises(RuntimeError, match="^Transcription failed$"):
            await task
        selected_model.transcribe.assert_not_called()
    finally:
        if lock_owned.locked():
            lock_owned.release()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.to_thread(worker_finished.wait, 2.0)


@pytest.mark.parametrize("audio_format", ["raw", "wav"])
@pytest.mark.parametrize("selector", ["realtime", "legacy-unspecified-model"])
@pytest.mark.asyncio
async def test_current_generation_preserves_finite_audio_and_legacy_selector(
    audio_format: str, selector: str
) -> None:
    service, realtime, accurate = _service_with_models()
    realtime.transcribe.return_value = (
        [SimpleNamespace(text="current result")],
        SimpleNamespace(language="en"),
    )

    result = await service.transcribe_audio(_audio_request(audio_format, selector))

    assert result.text == "current result"
    assert result.model_used == selector
    realtime.transcribe.assert_called_once()
    accurate.transcribe.assert_not_called()
    assert realtime.transcribe.call_args.kwargs == {
        "language": None,
        "beam_size": 1,
        "vad_filter": True,
    }
