"""STT startup continuations must not outlive their BaseService activation."""

from __future__ import annotations

import asyncio
import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

import app.services.stt_transcription.service as stt_service_module
from app.messaging import AudioTopics
from app.services.config.messages import ConfigChangedEvent
from app.services.stt_transcription.service import TranscriptionService
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.stt import STTControl, TranscribeAudioRequest
from app.shared.services.base_service import BaseService


def _new_transcription_service(monkeypatch) -> TranscriptionService:
    # Startup hooks are under test, but their decorated bus contracts are not.
    # Avoid mutating the process-global contract registry in this lifecycle suite.
    monkeypatch.setattr("app.shared.contracts.registry.register_module", Mock())
    monkeypatch.setattr("app.shared.contracts.registry.register_method", Mock())
    return TranscriptionService()


class ControlledBus:
    def __init__(self) -> None:
        self.subscribed_handlers: set[object] = set()
        self.subscribe_count = 0
        self.subscribe_entered: asyncio.Event | None = None
        self.release_subscribe: asyncio.Event | None = None

    async def subscribe_event(self, topic, handler) -> None:
        assert topic == AudioTopics.STREAM_MICROPHONE
        self.subscribe_count += 1
        if self.subscribe_entered is not None:
            self.subscribe_entered.set()
        if self.release_subscribe is not None:
            await self.release_subscribe.wait()
        self.subscribed_handlers.add(handler)

    def unsubscribe(self, topic, handler) -> None:
        assert topic == AudioTopics.STREAM_MICROPHONE
        self.subscribed_handlers.discard(handler)


class ConfigAwareControlledBus(ControlledBus):
    """Capture the real BaseService config callback alongside microphone hooks."""

    def __init__(self) -> None:
        super().__init__()
        self.config_handlers: set[object] = set()
        self.config_subscribe_count = 0
        self.microphone_subscribe_count = 0

    async def subscribe_event(self, topic, handler) -> None:
        if topic == ConfigMethods.UPDATED:
            self.config_subscribe_count += 1
            self.config_handlers.add(handler)
            return
        if topic == AudioTopics.STREAM_MICROPHONE:
            self.microphone_subscribe_count += 1
        await super().subscribe_event(topic, handler)

    def unsubscribe(self, topic, handler) -> None:
        if topic == ConfigMethods.UPDATED:
            self.config_handlers.discard(handler)
            return
        super().unsubscribe(topic, handler)


def _configure_start_boundaries(service: TranscriptionService, monkeypatch) -> ControlledBus:
    bus = ControlledBus()
    service._bus = bus
    monkeypatch.setattr(
        "app.shared.services.base_service.get_bus_singleton",
        Mock(side_effect=RuntimeError("use test bus")),
    )
    service._subscribe_to_config_changes = AsyncMock()
    service._unsubscribe_from_config_changes = Mock()
    service._subscribe_registered_contracts = AsyncMock()
    service._unsubscribe_registered_contracts = Mock()
    service._publish_service_announcement = AsyncMock()
    service._publish_service_departure = AsyncMock()
    service._start_gateway_announcement_loop = Mock()
    service._stop_gateway_announcement_loop = Mock()
    service._is_runtime_enabled = AsyncMock(return_value=True)
    service._ensure_huggingface_cache_env = Mock()
    service._initialize_vad = Mock()
    service._start_processing_thread = Mock()
    return bus


def _runtime_config(service: TranscriptionService):
    return (
        "en",
        service._language_policy,
        {"max_speech_duration_s": 30},
        True,
        True,
    )


@pytest.mark.parametrize("ending", ["deactivate", "stop"])
@pytest.mark.asyncio
async def test_ending_during_initial_config_read_retires_start(ending: str, monkeypatch) -> None:
    service = _new_transcription_service(monkeypatch)
    bus = _configure_start_boundaries(service, monkeypatch)
    config_read_entered = asyncio.Event()
    release_config_read = asyncio.Event()
    initial_language = service._language

    async def read_config():
        return await _read_held_config(
            config_read_entered, release_config_read, _runtime_config(service)
        )

    service._read_runtime_config = AsyncMock(side_effect=read_config)
    service._load_models = AsyncMock()

    start_task = asyncio.create_task(service.start())
    ending_task: asyncio.Task | None = None
    try:
        await asyncio.wait_for(config_read_entered.wait(), timeout=2.0)
        generation = service._runtime_generation
        if ending == "deactivate":
            ending_task = asyncio.create_task(service.deactivate(reason="retire-start"))
        else:
            ending_task = asyncio.create_task(service.stop())
        await asyncio.sleep(0)
        assert service._runtime_generation > generation

        release_config_read.set()
        await asyncio.gather(start_task, ending_task)

        assert service._runtime_state == ("inactive" if ending == "deactivate" else "stopped")
        assert service._running is False
        assert service._language == initial_language
        assert service._realtime_model is None
        assert service._accurate_model is None
        service._load_models.assert_not_awaited()
        service._start_processing_thread.assert_not_called()
        service._publish_service_announcement.assert_not_awaited()
        assert service._publish_service_departure.await_count == 0
        assert bus.subscribed_handlers == set()
    finally:
        release_config_read.set()
        for task in (start_task, ending_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (start_task, ending_task) if task is not None),
            return_exceptions=True,
        )


async def _read_held_config(entered, release, result):
    entered.set()
    await release.wait()
    return result


@pytest.mark.asyncio
async def test_stop_during_model_config_read_does_not_restore_models_or_start_thread(
    monkeypatch,
) -> None:
    service = _new_transcription_service(monkeypatch)
    bus = _configure_start_boundaries(service, monkeypatch)
    model_config_entered = asyncio.Event()
    release_model_config = asyncio.Event()
    read_count = 0

    async def read_config():
        nonlocal read_count
        read_count += 1
        if read_count == 1:
            return _runtime_config(service)
        return await _read_held_config(
            model_config_entered, release_model_config, _runtime_config(service)
        )

    service._read_runtime_config = AsyncMock(side_effect=read_config)
    replacement_models = (Mock(name="realtime-model"), Mock(name="accurate-model"))
    service._create_models = AsyncMock(return_value=replacement_models)
    start_task = asyncio.create_task(service.start())
    stop_task: asyncio.Task | None = None
    try:
        await asyncio.wait_for(model_config_entered.wait(), timeout=2.0)
        assert read_count == 2
        stop_task = asyncio.create_task(service.stop())
        await asyncio.sleep(0)
        release_model_config.set()
        await asyncio.gather(start_task, stop_task)

        assert service._runtime_state == "stopped"
        assert service._running is False
        assert service._create_models.await_count == 0
        assert service._realtime_model is None
        assert service._accurate_model is None
        assert bus.subscribed_handlers == set()
        service._start_processing_thread.assert_not_called()
        service._publish_service_announcement.assert_not_awaited()
    finally:
        release_model_config.set()
        for task in (start_task, stop_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (start_task, stop_task) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_stop_during_microphone_subscription_removes_late_subscription(
    monkeypatch,
) -> None:
    service = _new_transcription_service(monkeypatch)
    bus = _configure_start_boundaries(service, monkeypatch)
    bus.subscribe_entered = asyncio.Event()
    bus.release_subscribe = asyncio.Event()
    service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
    replacement_models = (Mock(name="realtime-model"), Mock(name="accurate-model"))
    service._create_models = AsyncMock(return_value=replacement_models)

    start_task = asyncio.create_task(service.start())
    stop_task: asyncio.Task | None = None
    try:
        await asyncio.wait_for(bus.subscribe_entered.wait(), timeout=2.0)
        service._create_models.assert_awaited_once()
        stop_task = asyncio.create_task(service.stop())
        await asyncio.sleep(0)
        bus.release_subscribe.set()
        await asyncio.gather(start_task, stop_task)

        assert service._runtime_state == "stopped"
        assert service._running is False
        assert service._realtime_model is None
        assert service._accurate_model is None
        assert bus.subscribed_handlers == set()
        service._start_processing_thread.assert_not_called()
        service._publish_service_announcement.assert_not_awaited()
    finally:
        if bus.release_subscribe is not None:
            bus.release_subscribe.set()
        for task in (start_task, stop_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (start_task, stop_task) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_normal_stt_start_stop_preserves_hook_and_subscription_behavior(
    monkeypatch,
) -> None:
    service = _new_transcription_service(monkeypatch)
    bus = _configure_start_boundaries(service, monkeypatch)
    service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
    realtime_model = Mock(name="realtime-model")
    accurate_model = Mock(name="accurate-model")
    service._create_models = AsyncMock(return_value=(realtime_model, accurate_model))

    await service.start()

    assert service._runtime_state == "active"
    assert service._running is True
    assert service._realtime_model is realtime_model
    assert service._accurate_model is accurate_model
    assert bus.subscribed_handlers == {service._on_audio_chunk}
    service._start_processing_thread.assert_called_once()
    service._publish_service_announcement.assert_awaited_once()

    await service.stop()

    assert service._runtime_state == "stopped"
    assert service._running is False
    assert service._realtime_model is None
    assert service._accurate_model is None
    assert bus.subscribed_handlers == set()
    service._start_processing_thread.assert_called_once()
    service._publish_service_departure.assert_awaited_once()


@pytest.mark.asyncio
async def test_start_does_not_replace_processing_thread_after_join_timeout(monkeypatch) -> None:
    service = _new_transcription_service(monkeypatch)
    bus = _configure_start_boundaries(service, monkeypatch)
    old_thread = Mock()
    old_thread.is_alive.return_value = True
    service._process_thread = old_thread
    service._runtime_state = "active"
    service._started = True
    service._runtime_resources_retired = False
    service._runtime_resource_generation = service._runtime_generation
    service._running = True
    service._transcribing = True
    service._realtime_model = Mock(name="old-realtime-model")
    service._accurate_model = Mock(name="old-accurate-model")
    service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
    service._create_models = AsyncMock(return_value=(Mock(), Mock()))

    await service.stop()
    old_thread.join.assert_called_once_with(timeout=5.0)
    assert old_thread.is_alive.return_value is True
    assert service._runtime_state == "stopped"
    assert service._process_thread is old_thread
    assert service._transcribing is False

    service._read_runtime_config.reset_mock()
    service._create_models.reset_mock()
    subscribe_count_after_stop = bus.subscribe_count

    replacement_thread = Mock()
    real_threading = stt_service_module.threading
    thread_factory = Mock(return_value=replacement_thread)
    monkeypatch.setattr(
        stt_service_module,
        "threading",
        SimpleNamespace(
            Thread=thread_factory,
            Lock=real_threading.Lock,
            Event=real_threading.Event,
        ),
    )
    # Exercise the real thread-creation guard, while keeping any accidentally
    # created replacement deterministic and unable to leak a worker.
    service._start_processing_thread = TranscriptionService._start_processing_thread.__get__(
        service
    )
    service._processing_loop = Mock()
    try:
        with pytest.raises(RuntimeError):
            await service.start()
    finally:
        if service._started:
            # The mock replacement has no actual thread to stop. Restore the
            # still-live original handle so normal cleanup cannot hide overlap.
            service._process_thread = old_thread
            await service.stop()
        elif bus.subscribed_handlers:
            # A failed startup can still have acquired the microphone hook.
            service._running = True
            service._process_thread = old_thread
            await service.on_stop()

    thread_factory.assert_not_called()
    replacement_thread.start.assert_not_called()
    service._read_runtime_config.assert_not_awaited()
    service._create_models.assert_not_awaited()
    assert bus.subscribe_count == subscribe_count_after_stop
    assert service._runtime_state != "active"
    assert old_thread.is_alive.return_value is True
    assert bus.subscribed_handlers == set()


@pytest.mark.parametrize("boundary", ["initial_config", "model_config", "microphone"])
@pytest.mark.parametrize("ending", ["deactivate", "stop"])
@pytest.mark.asyncio
async def test_retired_start_preserves_only_live_config_reactivation_path(
    boundary: str, ending: str, monkeypatch
) -> None:
    service = _new_transcription_service(monkeypatch)
    monkeypatch.setattr(
        "app.shared.services.base_service.get_bus_singleton",
        Mock(side_effect=RuntimeError("use test bus")),
    )
    _configure_start_boundaries(service, monkeypatch)
    bus = ConfigAwareControlledBus()
    service._bus = bus
    # Keep BaseService's actual process-level Config.Updated registration and
    # retirement behavior; only the external config and engine reads are fake.
    service._subscribe_to_config_changes = BaseService._subscribe_to_config_changes.__get__(service)
    service._unsubscribe_from_config_changes = BaseService._unsubscribe_from_config_changes.__get__(
        service
    )

    config_read_entered = asyncio.Event()
    release_config_read = asyncio.Event()
    read_count = 0
    target_read = {"initial_config": 1, "model_config": 2}.get(boundary)

    async def read_config():
        nonlocal read_count
        read_count += 1
        if read_count == target_read:
            config_read_entered.set()
            await release_config_read.wait()
        return _runtime_config(service)

    service._read_runtime_config = AsyncMock(side_effect=read_config)
    models = (Mock(name="realtime-model"), Mock(name="accurate-model"))
    service._create_models = AsyncMock(return_value=models)
    if boundary == "microphone":
        bus.subscribe_entered = asyncio.Event()
        bus.release_subscribe = release_config_read

    start_task: asyncio.Task | None = None
    ending_task: asyncio.Task | None = None
    callback_task: asyncio.Task | None = None
    config_callback = None
    try:
        start_task = asyncio.create_task(service.start())
        if boundary == "microphone":
            await asyncio.wait_for(bus.subscribe_entered.wait(), timeout=2.0)
        else:
            await asyncio.wait_for(config_read_entered.wait(), timeout=2.0)

        assert bus.config_subscribe_count == 1
        assert len(bus.config_handlers) == 1
        config_callback = next(iter(bus.config_handlers))
        prior_generation = service._runtime_generation
        if ending == "deactivate":
            ending_task = asyncio.create_task(service.deactivate(reason="retire-start"))
        else:
            ending_task = asyncio.create_task(service.stop())

        async def wait_for_intent() -> None:
            while service._runtime_generation <= prior_generation:
                await asyncio.sleep(0)

        await asyncio.wait_for(wait_for_intent(), timeout=2.0)
        release_config_read.set()
        if bus.release_subscribe is not None:
            bus.release_subscribe.set()
        await asyncio.gather(start_task, ending_task)

        if ending == "deactivate":
            assert service._runtime_state == "inactive"
            assert config_callback in bus.config_handlers
            assert bus.config_subscribe_count == 1

            callback_task = asyncio.create_task(
                config_callback(
                    SimpleNamespace(
                        payload=ConfigChangedEvent(
                            affected_sections=["services.stt.transcription"],
                            key_path="services.stt.transcription.enabled",
                            old_value=False,
                            new_value=True,
                        )
                    )
                )
            )
            await callback_task

            expected_model_loads = 2 if boundary == "microphone" else 1
            expected_microphone_subscribes = 2 if boundary == "microphone" else 1
            assert service._started is True
            assert service._runtime_state == "active"
            assert service._running is True
            assert service._realtime_model is models[0]
            assert service._accurate_model is models[1]
            assert config_callback in bus.config_handlers
            assert bus.config_subscribe_count == 1
            assert bus.subscribed_handlers == {service._on_audio_chunk}
            assert service._create_models.await_count == expected_model_loads
            assert bus.microphone_subscribe_count == expected_microphone_subscribes
            service._start_processing_thread.assert_called_once()
            service._publish_service_announcement.assert_awaited_once_with(
                runtime_generation=service._runtime_generation
            )
        else:
            assert service._runtime_state == "stopped"
            assert service._started is False
            assert config_callback not in bus.config_handlers
            assert bus.config_subscribe_count == 1
            assert bus.subscribed_handlers == set()
            assert service._start_processing_thread.call_count == 0
            service._publish_service_announcement.assert_not_awaited()

            # Calling the captured real callback after full stop must not
            # recreate models, microphone ownership, or service announcements.
            await config_callback(
                SimpleNamespace(
                    payload=ConfigChangedEvent(
                        affected_sections=["services.stt.transcription"],
                        key_path="services.stt.transcription.enabled",
                        old_value=False,
                        new_value=True,
                    )
                )
            )
            assert service._runtime_state == "stopped"
            assert service._create_models.await_count == (1 if boundary == "microphone" else 0)
            assert bus.subscribed_handlers == set()
            service._publish_service_announcement.assert_not_awaited()
    finally:
        release_config_read.set()
        if bus.release_subscribe is not None:
            bus.release_subscribe.set()
        tasks = [task for task in (start_task, ending_task, callback_task) if task is not None]
        if tasks:
            try:
                await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=2.0)
            except asyncio.TimeoutError:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        if service._runtime_state != "stopped":
            await service.stop()


@pytest.mark.asyncio
async def test_direct_stt_stop_hook_clears_started_without_base_owner(monkeypatch) -> None:
    service = _new_transcription_service(monkeypatch)
    _configure_start_boundaries(service, monkeypatch)
    service._started = True
    service._running = False

    await service.on_stop()

    assert service._started is False


@pytest.mark.asyncio
async def test_reload_during_stt_stop_does_not_construct_or_restore_models(monkeypatch) -> None:
    service = _new_transcription_service(monkeypatch)
    _configure_start_boundaries(service, monkeypatch)
    realtime_model = Mock(name="realtime-model")
    accurate_model = Mock(name="accurate-model")
    service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
    service._create_models = AsyncMock(return_value=(realtime_model, accurate_model))

    await service.start()

    config_read_entered = asyncio.Event()
    release_config_read = asyncio.Event()

    async def held_reload_config():
        config_read_entered.set()
        await release_config_read.wait()
        return _runtime_config(service)

    replacement_models = (Mock(name="replacement-realtime"), Mock(name="replacement-accurate"))

    async def construct_replacement(*_args, **_kwargs):
        service._model_status["realtime"] = "preparing_model"
        service._model_status["accurate"] = "preparing_model"
        return replacement_models

    service._read_runtime_config = AsyncMock(side_effect=held_reload_config)
    service._create_models = AsyncMock(side_effect=construct_replacement)
    status_before_reload = dict(service._model_status)
    status_message_before_reload = dict(service._model_status_message)
    capabilities_before_reload = list(service._capabilities)
    announcement_count = service._publish_service_announcement.await_count
    await service._speech_stream_lock.acquire()
    stop_task = asyncio.create_task(service.stop())
    reload_task: asyncio.Task[None] | None = None
    config_waiter = asyncio.create_task(config_read_entered.wait())
    try:

        async def wait_for_stop_cleanup() -> None:
            while service._runtime_state != "stopping" or service._running:
                await asyncio.sleep(0)

        await asyncio.wait_for(wait_for_stop_cleanup(), timeout=2.0)
        reload_task = asyncio.create_task(service.reload("services.stt"))
        done, _ = await asyncio.wait(
            {reload_task, config_waiter},
            timeout=2.0,
            return_when=asyncio.FIRST_COMPLETED,
        )
        assert done, "reload neither retired early nor reached its controlled config read"
        if config_waiter in done:
            release_config_read.set()
        await reload_task

        assert service._runtime_state == "stopping"
        assert service._realtime_model is realtime_model
        assert service._accurate_model is accurate_model
        assert service._model_status == status_before_reload
        assert service._model_status_message == status_message_before_reload
        assert service._capabilities == capabilities_before_reload
        service._create_models.assert_not_awaited()
        assert service._publish_service_announcement.await_count == announcement_count
        release_config_read.set()
        if service._speech_stream_lock.locked():
            service._speech_stream_lock.release()
        await stop_task
        assert service._runtime_state == "stopped"
        assert service._create_models.await_count == 0
    finally:
        release_config_read.set()
        if service._speech_stream_lock.locked():
            service._speech_stream_lock.release()
        tasks = [task for task in (stop_task, reload_task, config_waiter) if task is not None]
        try:
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=2.0)
        except asyncio.TimeoutError:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_enable_control_after_stop_does_not_change_readiness(monkeypatch) -> None:
    service = _new_transcription_service(monkeypatch)
    _configure_start_boundaries(service, monkeypatch)
    disabled_realtime_config = (
        "en",
        service._language_policy,
        {"max_speech_duration_s": 30},
        False,
        True,
    )
    service._read_runtime_config = AsyncMock(return_value=disabled_realtime_config)
    service._create_models = AsyncMock(return_value=(Mock(), Mock()))

    await service.start()
    await service.stop()
    announcement_count = service._publish_service_announcement.await_count

    await service._on_control(STTControl(action="enable_realtime", enabled=True))

    assert service._runtime_state == "stopped"
    assert service._realtime_enabled is False
    assert service._publish_service_announcement.await_count == announcement_count


def _set_active_worker_state(service: TranscriptionService) -> Mock:
    worker = Mock(name="active-processing-worker")
    worker.is_alive.return_value = True
    service._process_thread = worker
    service._runtime_state = "active"
    service._runtime_resources_retired = False
    service._started = True
    service._running = True
    service._transcribing = True
    return worker


@pytest.mark.asyncio
async def test_finite_transcription_remains_available_with_active_processing_worker(
    monkeypatch,
) -> None:
    service = _new_transcription_service(monkeypatch)
    _configure_start_boundaries(service, monkeypatch)
    worker = _set_active_worker_state(service)
    model = Mock(name="realtime-model")
    model.transcribe.return_value = (
        [SimpleNamespace(text="active worker accepted")],
        SimpleNamespace(language="en"),
    )
    service._realtime_model = model
    service._realtime_enabled = True
    request = TranscribeAudioRequest(
        audio_data=base64.b64encode(b"\x01\x00" * 16000).decode("ascii"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model="realtime",
    )

    result = await service.transcribe_audio(request)

    assert worker.is_alive()
    assert result.text == "active worker accepted"
    model.transcribe.assert_called_once()


@pytest.mark.asyncio
async def test_reload_remains_available_with_active_processing_worker(monkeypatch) -> None:
    service = _new_transcription_service(monkeypatch)
    _configure_start_boundaries(service, monkeypatch)
    worker = _set_active_worker_state(service)
    current_realtime = Mock(name="current-realtime")
    current_accurate = Mock(name="current-accurate")
    replacement_realtime = Mock(name="replacement-realtime")
    replacement_accurate = Mock(name="replacement-accurate")
    service._realtime_model = current_realtime
    service._accurate_model = current_accurate
    config = {"max_speech_duration_s": 30}
    service._read_runtime_config = AsyncMock(
        return_value=("en", service._language_policy, config, True, True)
    )
    service._create_models = AsyncMock(return_value=(replacement_realtime, replacement_accurate))

    await service.reload("services.stt")

    assert worker.is_alive()
    service._read_runtime_config.assert_awaited_once()
    service._create_models.assert_awaited_once()
    assert service._realtime_model is replacement_realtime
    assert service._accurate_model is replacement_accurate


@pytest.mark.asyncio
async def test_enable_control_remains_available_with_active_processing_worker(monkeypatch) -> None:
    service = _new_transcription_service(monkeypatch)
    _configure_start_boundaries(service, monkeypatch)
    worker = _set_active_worker_state(service)
    service._realtime_enabled = False
    service._realtime_model = Mock(name="realtime-model")

    await service._on_control(STTControl(action="enable_realtime", enabled=True))

    assert worker.is_alive()
    assert service._realtime_enabled is True
    service._publish_service_announcement.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("ending", ["deactivate", "stop"])
async def test_retained_model_stays_closed_until_fresh_activation_after_worker_exits(
    monkeypatch, ending: str
) -> None:
    service = _new_transcription_service(monkeypatch)
    bus = _configure_start_boundaries(service, monkeypatch)
    old_thread = Mock(name="retained-processing-worker")
    old_thread.is_alive.return_value = True
    old_model = Mock(name="retained-realtime-model")
    old_model.transcribe.return_value = (
        [SimpleNamespace(text="retired model result")],
        SimpleNamespace(language="en"),
    )
    old_accurate = Mock(name="retained-accurate-model")
    service._process_thread = old_thread
    service._runtime_state = "active"
    service._runtime_resources_retired = False
    service._started = True
    service._running = True
    service._transcribing = True
    service._realtime_model = old_model
    service._accurate_model = old_accurate
    service._realtime_enabled = True
    service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
    replacement_model = Mock(name="replacement-realtime-model")
    replacement_model.transcribe.return_value = (
        [SimpleNamespace(text="replacement model accepted")],
        SimpleNamespace(language="en"),
    )
    replacement_accurate = Mock(name="replacement-accurate-model")
    service._create_models = AsyncMock(return_value=(replacement_model, replacement_accurate))

    if ending == "deactivate":
        await service.deactivate(reason="bounded join retained worker")
        assert service._runtime_state == "inactive"
    else:
        await service.stop()
        assert service._runtime_state == "stopped"
    assert service._process_thread is old_thread
    assert service._realtime_model is old_model

    old_thread.is_alive.return_value = False
    request = TranscribeAudioRequest(
        audio_data=base64.b64encode(b"\x01\x00" * 16000).decode("ascii"),
        format="raw",
        sample_rate=16000,
        channels=1,
        model="realtime",
    )
    with pytest.raises(RuntimeError, match="^Transcription failed$"):
        await service.transcribe_audio(request)
    old_model.transcribe.assert_not_called()

    if ending == "deactivate":
        await service.activate(reason="after-worker-exit")
    else:
        await service.start()

    assert service._runtime_state == "active"
    assert service._realtime_model is replacement_model
    assert service._accurate_model is replacement_accurate
    assert service._process_thread is None
    assert bus.subscribed_handlers == {service._on_audio_chunk}

    result = await service.transcribe_audio(request)

    assert result.text == "replacement model accepted"
    replacement_model.transcribe.assert_called_once()


@pytest.mark.asyncio
async def test_finite_transcription_does_not_start_after_stop_intent(monkeypatch) -> None:
    service = _new_transcription_service(monkeypatch)
    _configure_start_boundaries(service, monkeypatch)
    model = Mock(name="realtime-model")
    model.transcribe = Mock(
        return_value=([SimpleNamespace(text="stale transcript")], SimpleNamespace(language="en"))
    )
    service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
    service._create_models = AsyncMock(return_value=(model, Mock(name="accurate-model")))
    announcement_entered = asyncio.Event()
    release_announcement = asyncio.Event()
    release_departure = asyncio.Event()

    async def held_announcement(*_args, **_kwargs):
        announcement_entered.set()
        await release_announcement.wait()

    async def held_departure(*_args, **_kwargs):
        await release_departure.wait()

    service._publish_service_announcement = AsyncMock(side_effect=held_announcement)
    service._publish_service_departure = AsyncMock(side_effect=held_departure)
    start_task = asyncio.create_task(service.start())
    stop_task: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(announcement_entered.wait(), timeout=2.0)
        assert service._runtime_state == "active"
        previous_generation = service._runtime_generation
        stop_task = asyncio.create_task(service.stop())
        for _ in range(100):
            if service._runtime_generation > previous_generation:
                break
            await asyncio.sleep(0)
        assert service._runtime_generation > previous_generation
        assert service._realtime_model is model

        request = TranscribeAudioRequest(
            audio_data=base64.b64encode(b"\x00\x00" * 16000).decode("ascii"),
            format="raw",
            sample_rate=16000,
            channels=1,
            model="realtime",
        )
        with pytest.raises(RuntimeError, match="^Transcription failed$"):
            await service.transcribe_audio(request)
        model.transcribe.assert_not_called()

        release_announcement.set()
        release_departure.set()
        await asyncio.gather(start_task, stop_task)
        assert service._runtime_state == "stopped"
        assert service._started is False
    finally:
        release_announcement.set()
        release_departure.set()
        tasks = [task for task in (start_task, stop_task) if task is not None]
        try:
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=2.0)
        except asyncio.TimeoutError:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_pending_stop_blocks_reload_while_active_start_owner_finishes(monkeypatch) -> None:
    service = _new_transcription_service(monkeypatch)
    _configure_start_boundaries(service, monkeypatch)
    realtime_model = Mock(name="realtime-model")
    accurate_model = Mock(name="accurate-model")
    service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
    service._create_models = AsyncMock(return_value=(realtime_model, accurate_model))
    announcement_entered = asyncio.Event()
    release_announcement = asyncio.Event()
    release_departure = asyncio.Event()

    async def held_announcement(*_args, **_kwargs):
        announcement_entered.set()
        await release_announcement.wait()

    async def held_departure(*_args, **_kwargs):
        await release_departure.wait()

    service._publish_service_announcement = AsyncMock(side_effect=held_announcement)
    service._publish_service_departure = AsyncMock(side_effect=held_departure)
    start_task = asyncio.create_task(service.start())
    stop_task: asyncio.Task[None] | None = None
    reload_task: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(announcement_entered.wait(), timeout=2.0)
        assert service._runtime_state == "active"
        previous_generation = service._runtime_generation
        stop_task = asyncio.create_task(service.stop())
        for _ in range(100):
            if service._runtime_generation > previous_generation:
                break
            await asyncio.sleep(0)
        assert service._runtime_generation > previous_generation
        assert service._realtime_model is realtime_model
        assert service._accurate_model is accurate_model

        service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
        replacement_models = (Mock(name="replacement-realtime"), Mock(name="replacement-accurate"))

        async def construct_replacement(*_args, **_kwargs):
            service._model_status["realtime"] = "preparing_model"
            service._model_status["accurate"] = "preparing_model"
            return replacement_models

        service._create_models = AsyncMock(side_effect=construct_replacement)
        status_before_reload = dict(service._model_status)
        capabilities_before_reload = list(service._capabilities)
        reload_task = asyncio.create_task(service.reload("services.stt"))
        await asyncio.sleep(0)

        assert service._realtime_model is realtime_model
        assert service._accurate_model is accurate_model
        assert service._model_status == status_before_reload
        assert service._capabilities == capabilities_before_reload
        service._create_models.assert_not_awaited()

        release_announcement.set()
        release_departure.set()
        await asyncio.gather(start_task, stop_task, reload_task)
        assert service._runtime_state == "stopped"
        assert service._started is False
        assert service._realtime_model is None
        assert service._accurate_model is None
        service._create_models.assert_not_awaited()
    finally:
        release_announcement.set()
        release_departure.set()
        tasks = [task for task in (start_task, stop_task, reload_task) if task is not None]
        try:
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=2.0)
        except asyncio.TimeoutError:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_pending_stop_blocks_enable_control_while_active_start_owner_finishes(
    monkeypatch,
) -> None:
    service = _new_transcription_service(monkeypatch)
    _configure_start_boundaries(service, monkeypatch)
    service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
    service._create_models = AsyncMock(return_value=(Mock(), Mock()))
    announcement_entered = asyncio.Event()
    release_announcement = asyncio.Event()
    release_departure = asyncio.Event()

    async def held_announcement(*_args, **_kwargs):
        announcement_entered.set()
        await release_announcement.wait()

    async def held_departure(*_args, **_kwargs):
        await release_departure.wait()

    service._publish_service_announcement = AsyncMock(side_effect=held_announcement)
    service._publish_service_departure = AsyncMock(side_effect=held_departure)
    start_task = asyncio.create_task(service.start())
    stop_task: asyncio.Task[None] | None = None
    control_task: asyncio.Task | None = None
    try:
        await asyncio.wait_for(announcement_entered.wait(), timeout=2.0)
        assert service._runtime_state == "active"
        previous_generation = service._runtime_generation
        stop_task = asyncio.create_task(service.stop())
        for _ in range(100):
            if service._runtime_generation > previous_generation:
                break
            await asyncio.sleep(0)
        assert service._runtime_generation > previous_generation
        assert service._realtime_enabled is True
        control_task = asyncio.create_task(
            service._on_control(STTControl(action="enable_realtime", enabled=False))
        )
        await asyncio.sleep(0)

        assert service._realtime_enabled is True

        release_announcement.set()
        release_departure.set()
        await asyncio.gather(start_task, stop_task, control_task)
        assert service._runtime_state == "stopped"
        assert service._realtime_enabled is True
    finally:
        release_announcement.set()
        release_departure.set()
        tasks = [task for task in (start_task, stop_task, control_task) if task is not None]
        try:
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=2.0)
        except asyncio.TimeoutError:
            for task in tasks:
                if not task.done():
                    task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize("phase", ["inactive", "failed-restart"])
@pytest.mark.parametrize("operation", ["finite", "reload", "enable"])
@pytest.mark.asyncio
async def test_retained_worker_closes_finite_reload_and_enable_paths(
    monkeypatch, phase: str, operation: str
) -> None:
    service = _new_transcription_service(monkeypatch)
    _configure_start_boundaries(service, monkeypatch)
    realtime_model = Mock(name="retained-realtime-model")
    realtime_model.transcribe.return_value = (
        [SimpleNamespace(text="stale worker result")],
        SimpleNamespace(language="en"),
    )
    accurate_model = Mock(name="retained-accurate-model")
    service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
    service._create_models = AsyncMock(return_value=(realtime_model, accurate_model))
    service._republish_readiness = AsyncMock()

    await service.start()
    old_thread = Mock(name="still-running-transcription-worker")
    old_thread.is_alive.return_value = True
    service._process_thread = old_thread
    await service.deactivate(reason="retain worker after bounded join")
    assert service._runtime_state == "inactive"
    assert service._realtime_model is realtime_model
    assert service._process_thread is old_thread
    old_thread.join.assert_called_with(timeout=5.0)
    assert old_thread.is_alive() is True

    if phase == "failed-restart":
        with pytest.raises(RuntimeError, match="Transcription processing is still stopping"):
            await service.activate(reason="reject overlap with retained worker")
        assert service._runtime_state == "failed"
        assert service._process_thread is old_thread
        assert old_thread.is_alive() is True

    model_revision = service._model_revision
    if operation == "finite":
        service._decode_audio_to_numpy = Mock(return_value=[0.0])
        request = TranscribeAudioRequest(
            audio_data=base64.b64encode(b"\x00\x00").decode("ascii"),
            format="raw",
            sample_rate=16000,
            channels=1,
            model="realtime",
        )
        with pytest.raises(RuntimeError, match="Transcription failed"):
            await service.transcribe_audio(request)
        realtime_model.transcribe.assert_not_called()
    elif operation == "reload":
        service._read_runtime_config = AsyncMock(return_value=_runtime_config(service))
        service._create_models = AsyncMock(return_value=(Mock(), Mock()))
        await service.reload("services.stt")
        service._create_models.assert_not_awaited()
        assert service._realtime_model is realtime_model
    else:
        service._realtime_enabled = False
        await service._on_control(STTControl(action="enable_realtime", enabled=True))
        assert service._realtime_enabled is False

    assert service._model_revision == model_revision
    assert service._process_thread is old_thread
    if service._runtime_state != "stopped":
        await service.stop()
