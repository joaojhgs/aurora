"""Lifecycle retirement races for BaseService operations."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, Mock

import pytest

from app.messaging import Envelope
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.registry import unregister_module
from app.shared.services.base_service import BaseService


class ControlledLifecycleService(BaseService):
    def __init__(self) -> None:
        self.start_calls = 0
        self.stop_calls = 0
        self.resource_owner: int | None = None
        self.entered: dict[int, asyncio.Event] = {}
        self.release: dict[int, asyncio.Event] = {}
        self.fail_first_start = False
        self.fail_after_resource_start = False
        self.reenter_deactivation = False
        super().__init__(module="LifecycleRetirementTest", summary="Lifecycle retirement test")

    async def _is_runtime_enabled(self) -> bool:
        return True

    async def on_start(self) -> None:
        self.start_calls += 1
        call = self.start_calls
        self.entered.setdefault(call, asyncio.Event()).set()
        if call in self.release:
            await self.release[call].wait()
        self.resource_owner = call
        if self.fail_first_start and call == 1:
            raise RuntimeError("controlled stale activation failure")
        if self.fail_after_resource_start and call == 1:
            raise RuntimeError("controlled partial startup failure")
        if self.reenter_deactivation:
            await self.deactivate(reason="reentrant-on-start")

    async def on_stop(self) -> None:
        self.stop_calls += 1
        self.resource_owner = None

    async def reload(self, config_section: str | None = None) -> None:
        return None


def _install_boundary_fakes(service: ControlledLifecycleService) -> dict[str, Mock]:
    service.contracts_ready = False

    async def subscribe_contracts(*_args, only_always_available=False, **_kwargs) -> None:
        service.contracts_ready = not only_always_available

    def unsubscribe_contracts(*_args, **_kwargs) -> None:
        service.contracts_ready = False

    service._subscribe_to_config_changes = AsyncMock()
    service._unsubscribe_from_config_changes = Mock()
    service._subscribe_registered_contracts = AsyncMock(side_effect=subscribe_contracts)
    service._unsubscribe_registered_contracts = Mock(side_effect=unsubscribe_contracts)
    service._publish_service_announcement = AsyncMock()
    service._publish_service_departure = AsyncMock()
    service._start_gateway_announcement_loop = Mock()
    service._stop_gateway_announcement_loop = Mock()
    return {
        "announce": service._publish_service_announcement,
        "depart": service._publish_service_departure,
        "subscribe": service._subscribe_registered_contracts,
        "unsubscribe": service._unsubscribe_registered_contracts,
        "start_loop": service._start_gateway_announcement_loop,
    }


@pytest.fixture
def lifecycle_service(monkeypatch):
    monkeypatch.setattr(
        "app.shared.services.base_service.get_bus_singleton",
        Mock(side_effect=RuntimeError("use test bus")),
    )
    service = ControlledLifecycleService()
    service._bus = Mock()
    fakes = _install_boundary_fakes(service)
    try:
        yield service, fakes
    finally:
        unregister_module(service.module)


async def _wait_for_generation_change(service: ControlledLifecycleService, previous: int) -> None:
    for _ in range(100):
        if service._runtime_generation > previous:
            return
        await asyncio.sleep(0)
    pytest.fail("lifecycle request did not reserve an intent within 100 loop turns")


async def _wait_for_lifecycle_state(
    service: ControlledLifecycleService, expected_state: str, expected_started: bool
) -> None:
    async def wait_for_state() -> None:
        while service._runtime_state != expected_state or service._started is not expected_started:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_for_state(), timeout=2.0)


@pytest.mark.asyncio
async def test_deactivate_during_start_retires_activation_before_announcement(
    lifecycle_service,
) -> None:
    service, fakes = lifecycle_service
    service.release[1] = asyncio.Event()
    start_task = asyncio.create_task(service.start())
    try:
        await asyncio.wait_for(service.entered.setdefault(1, asyncio.Event()).wait(), timeout=2.0)
        generation = service._runtime_generation
        deactivate_task = asyncio.create_task(service.deactivate(reason="test-retirement"))
        await asyncio.sleep(0)
        assert service._runtime_generation > generation
        service.release[1].set()
        await asyncio.gather(start_task, deactivate_task)

        assert service._runtime_state == "inactive"
        assert service.resource_owner is None
        assert service.contracts_ready is False
        fakes["announce"].assert_not_awaited()
        fakes["start_loop"].assert_not_called()
    finally:
        service.release[1].set()
        for task in (start_task, locals().get("deactivate_task")):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (start_task, locals().get("deactivate_task")) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_stale_activation_failure_cannot_overwrite_newer_success(lifecycle_service) -> None:
    service, fakes = lifecycle_service
    service.fail_first_start = True
    service.release[1] = asyncio.Event()
    old_activation = asyncio.create_task(service.activate(reason="old"))
    deactivation: asyncio.Task[None] | None = None
    newer_activation: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(service.entered.setdefault(1, asyncio.Event()).wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        deactivation = asyncio.create_task(service.deactivate(reason="retire-old"))
        await _wait_for_generation_change(service, previous_generation)
        newer_activation = asyncio.create_task(service.activate(reason="new"))
        # Give a non-serialized lifecycle implementation one cooperative turn.
        # A serialized implementation keeps the distinct post-deactivation
        # activation queued until old cleanup finishes, which is also valid.
        await asyncio.sleep(0)
        second_started_early = service.entered.get(2, asyncio.Event()).is_set()
        if second_started_early:
            assert service.resource_owner == 2

        service.release[1].set()
        with pytest.raises(RuntimeError, match="controlled stale activation failure"):
            await old_activation
        await asyncio.gather(deactivation, newer_activation)

        assert service._runtime_state == "active"
        assert service._started is True
        assert service.resource_owner == 2
        assert service.contracts_ready is True
        assert fakes["announce"].await_count == 1
    finally:
        service.release[1].set()
        for task in (old_activation, deactivation, newer_activation):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(
                task
                for task in (old_activation, deactivation, newer_activation)
                if task is not None
            ),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_newer_start_retries_after_retired_start_failure(lifecycle_service) -> None:
    service, fakes = lifecycle_service
    service.fail_first_start = True
    service.release[1] = asyncio.Event()
    retired_start = asyncio.create_task(service.start())
    stop_request: asyncio.Task[None] | None = None
    replacement_start: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(service.entered.setdefault(1, asyncio.Event()).wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        stop_request = asyncio.create_task(service.stop())
        await _wait_for_generation_change(service, previous_generation)
        previous_generation = service._runtime_generation
        replacement_start = asyncio.create_task(service.start())
        await _wait_for_generation_change(service, previous_generation)

        service.release[1].set()
        with pytest.raises(RuntimeError, match="controlled stale activation failure"):
            await retired_start
        await asyncio.gather(stop_request, replacement_start)

        assert service._runtime_state == "active"
        assert service._started is True
        assert service.resource_owner == 2
        assert service.contracts_ready is True
        assert service.start_calls == 2
        assert fakes["announce"].await_count == 1
    finally:
        service.release[1].set()
        for task in (retired_start, stop_request, replacement_start):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (retired_start, stop_request, replacement_start) if task),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_adjacent_activate_callers_share_one_failure(lifecycle_service) -> None:
    service, _fakes = lifecycle_service
    service.fail_first_start = True
    service.release[1] = asyncio.Event()
    first = asyncio.create_task(service.activate(reason="first"))
    second: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(service.entered.setdefault(1, asyncio.Event()).wait(), timeout=2.0)
        second = asyncio.create_task(service.activate(reason="second"))
        await asyncio.sleep(0)
        assert not second.done(), "adjacent activate callers should await one managed attempt"

        service.release[1].set()
        outcomes = await asyncio.gather(first, second, return_exceptions=True)

        assert all(
            isinstance(outcome, RuntimeError)
            and str(outcome) == "controlled stale activation failure"
            for outcome in outcomes
        )
        assert service.start_calls == 1
        assert service._runtime_state == "failed"
        assert service.resource_owner is None
    finally:
        service.release[1].set()
        for task in (first, second):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (first, second) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_late_deactivation_cleanup_cannot_overwrite_new_activation(
    lifecycle_service,
) -> None:
    service, fakes = lifecycle_service
    await service.start()
    departure_entered = asyncio.Event()
    release_departure = asyncio.Event()

    async def held_departure(*_args, **_kwargs) -> None:
        departure_entered.set()
        await release_departure.wait()

    service._publish_service_departure = AsyncMock(side_effect=held_departure)
    deactivation = asyncio.create_task(service.deactivate(reason="controlled-shutdown"))
    activation: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(departure_entered.wait(), timeout=2.0)
        activation = asyncio.create_task(service.activate(reason="replacement"))
        # Let a concurrent implementation advance if it permits overlapping
        # lifecycle operations; a serialized implementation keeps it queued.
        await asyncio.sleep(0)
        release_departure.set()
        await asyncio.gather(deactivation, activation)

        assert service._runtime_state == "active"
        assert service._started is True
        assert service.resource_owner == 2
        assert service.contracts_ready is True
        assert fakes["announce"].await_count == 2
    finally:
        release_departure.set()
        for task in (deactivation, activation):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (deactivation, activation) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_normal_start_stop_and_activate_idempotency_remain_supported(
    lifecycle_service,
) -> None:
    service, fakes = lifecycle_service

    await service.start()
    assert service._runtime_state == "active"
    assert service.resource_owner == 1
    generation = service._runtime_generation
    loop_starts = fakes["start_loop"].call_count
    await service.activate(reason="already-active")
    await service.start()
    assert service.start_calls == 1
    assert service._runtime_generation == generation
    assert fakes["start_loop"].call_count == loop_starts

    await service.stop()

    assert service._runtime_state == "stopped"
    assert service._started is False
    assert service.resource_owner is None
    assert service.stop_calls == 1
    assert fakes["announce"].await_count == 1


@pytest.mark.asyncio
async def test_partial_on_start_failure_cleans_resource_before_propagating(
    lifecycle_service,
) -> None:
    service, _fakes = lifecycle_service
    service.fail_after_resource_start = True

    with pytest.raises(RuntimeError, match="controlled partial startup failure"):
        await service.activate(reason="partial-failure")

    assert service.start_calls == 1
    assert service.stop_calls == 1
    assert service.resource_owner is None
    assert service.contracts_ready is False
    assert service._runtime_state == "failed"
    assert service._started is False


@pytest.mark.asyncio
async def test_repeated_start_coalesces_while_initial_enabled_lookup_is_pending(
    lifecycle_service,
) -> None:
    service, fakes = lifecycle_service
    lookup_entered = asyncio.Event()
    release_lookup = asyncio.Event()

    async def held_enabled_lookup() -> bool:
        lookup_entered.set()
        await release_lookup.wait()
        return True

    service._is_runtime_enabled = AsyncMock(side_effect=held_enabled_lookup)
    first_start = asyncio.create_task(service.start())
    second_start: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(lookup_entered.wait(), timeout=2.0)
        second_start = asyncio.create_task(service.start())
        await asyncio.sleep(0)
        assert not second_start.done(), "same-kind start should await its pending transition"

        release_lookup.set()
        await asyncio.gather(first_start, second_start)

        assert service._runtime_state == "active"
        assert service.start_calls == 1
        assert fakes["announce"].await_count == 1
    finally:
        release_lookup.set()
        for task in (first_start, second_start):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (first_start, second_start) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_stop_intent_survives_cancellation_while_waiting_for_deactivation(
    lifecycle_service,
) -> None:
    service, _fakes = lifecycle_service
    await service.start()
    hook_entered = asyncio.Event()
    release_hook = asyncio.Event()
    original_on_stop = service.on_stop

    async def held_deactivation() -> None:
        await original_on_stop()
        hook_entered.set()
        await release_hook.wait()

    service.on_deactivate = AsyncMock(side_effect=held_deactivation)
    deactivation = asyncio.create_task(service.deactivate(reason="first-transition"))
    stop_request: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(hook_entered.wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        stop_request = asyncio.create_task(service.stop())
        await _wait_for_generation_change(service, previous_generation)

        # The request has reserved its place. Cancelling the waiter must not
        # withdraw the accepted stop while the first transition owns cleanup.
        if stop_request.done():
            await stop_request
        else:
            stop_request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await stop_request

        release_hook.set()
        await deactivation
        await _wait_for_lifecycle_state(service, "stopped", expected_started=False)

        assert service._runtime_state == "stopped"
        assert service._started is False
        assert service.resource_owner is None
    finally:
        release_hook.set()
        for task in (deactivation, stop_request):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (deactivation, stop_request) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_repeated_stop_coalesces_while_departure_is_pending(lifecycle_service) -> None:
    service, _fakes = lifecycle_service
    await service.start()
    departure_entered = asyncio.Event()
    release_departure = asyncio.Event()

    async def held_departure(*_args, **_kwargs) -> None:
        departure_entered.set()
        await release_departure.wait()

    service._publish_service_departure = AsyncMock(side_effect=held_departure)
    first_stop = asyncio.create_task(service.stop())
    second_stop: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(departure_entered.wait(), timeout=2.0)
        second_stop = asyncio.create_task(service.stop())
        await asyncio.sleep(0)
        assert not second_stop.done(), "same-kind stop should await its pending transition"

        release_departure.set()
        await asyncio.gather(first_stop, second_stop)

        assert service._runtime_state == "stopped"
        assert service._started is False
        assert service.stop_calls == 1
    finally:
        release_departure.set()
        for task in (first_stop, second_stop):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (first_stop, second_stop) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_activation_after_pending_stop_is_the_final_intent(lifecycle_service) -> None:
    service, fakes = lifecycle_service
    await service.start()
    departure_entered = asyncio.Event()
    release_departure = asyncio.Event()

    async def held_departure(*_args, **_kwargs) -> None:
        departure_entered.set()
        await release_departure.wait()

    service._publish_service_departure = AsyncMock(side_effect=held_departure)
    stop_task = asyncio.create_task(service.stop())
    activation: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(departure_entered.wait(), timeout=2.0)
        activation = asyncio.create_task(service.activate(reason="newer-active-intent"))
        release_departure.set()
        await asyncio.gather(stop_task, activation)

        assert service._runtime_state == "active"
        assert service._started is True
        assert service.resource_owner == 2
        assert service.contracts_ready is True
        assert fakes["announce"].await_count == 2
    finally:
        release_departure.set()
        for task in (stop_task, activation):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (stop_task, activation) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_stop_retires_start_waiting_for_enabled_config_lookup(lifecycle_service) -> None:
    service, fakes = lifecycle_service
    lookup_entered = asyncio.Event()
    release_lookup = asyncio.Event()

    async def held_enabled_lookup() -> bool:
        lookup_entered.set()
        await release_lookup.wait()
        return True

    service._is_runtime_enabled = AsyncMock(side_effect=held_enabled_lookup)
    start_task = asyncio.create_task(service.start())
    stop_task: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(lookup_entered.wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        stop_task = asyncio.create_task(service.stop())
        await _wait_for_generation_change(service, previous_generation)
        release_lookup.set()
        await asyncio.gather(start_task, stop_task)

        assert service._runtime_state == "stopped"
        assert service._started is False
        assert service.start_calls == 0
        assert service.resource_owner is None
        fakes["announce"].assert_not_awaited()
        fakes["start_loop"].assert_not_called()
    finally:
        release_lookup.set()
        for task in (start_task, stop_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (start_task, stop_task) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_activation_superseding_startup_keeps_config_subscription(lifecycle_service) -> None:
    from app.services.config.messages import ConfigChangedEvent

    service, _fakes = lifecycle_service

    class ConfigTrackingBus:
        def __init__(self) -> None:
            self.handlers: set[object] = set()

        async def subscribe_event(self, topic, handler) -> None:
            assert topic == ConfigMethods.UPDATED
            self.handlers.add(handler)

        def unsubscribe(self, topic, handler) -> None:
            assert topic == ConfigMethods.UPDATED
            self.handlers.discard(handler)

    bus = ConfigTrackingBus()
    service._bus = bus
    service._config_change_subscription = None
    service._enabled_config_path = Mock(return_value="services.lifecycle.enabled")
    service._subscribe_to_config_changes = BaseService._subscribe_to_config_changes.__get__(service)
    service._unsubscribe_from_config_changes = BaseService._unsubscribe_from_config_changes.__get__(
        service
    )
    lookup_entered = asyncio.Event()
    release_lookup = asyncio.Event()

    async def held_enabled_lookup() -> bool:
        lookup_entered.set()
        await release_lookup.wait()
        return True

    service._is_runtime_enabled = AsyncMock(side_effect=held_enabled_lookup)
    start_request = asyncio.create_task(service.start())
    activation: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(lookup_entered.wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        activation = asyncio.create_task(service.activate(reason="successor"))
        await _wait_for_generation_change(service, previous_generation)

        release_lookup.set()
        await asyncio.gather(start_request, activation)

        assert service._runtime_state == "active"
        assert service.resource_owner == 1
        assert service._config_change_subscription is not None
        assert len(bus.handlers) == 1

        service._is_runtime_enabled = AsyncMock(return_value=False)
        callback = next(iter(bus.handlers))
        await callback(
            Envelope(
                type=ConfigMethods.UPDATED,
                payload=ConfigChangedEvent(
                    key_path="services.lifecycle.enabled",
                    affected_sections=["services.lifecycle", "services.lifecycle.enabled"],
                    old_value=True,
                    new_value=False,
                ),
            )
        )

        assert service._runtime_state == "inactive"
        assert service._started is True
        assert service.resource_owner is None
        assert service._config_change_subscription is not None
        assert bus.handlers == {callback}

        await service.stop()
        assert service._config_change_subscription is None
        assert bus.handlers == set()
    finally:
        release_lookup.set()
        for task in (start_request, activation):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (start_request, activation) if task is not None),
            return_exceptions=True,
        )
        if service._runtime_state != "stopped":
            await service.stop()


@pytest.mark.asyncio
async def test_delayed_enabled_config_callback_cannot_resurrect_stopped_service(
    lifecycle_service,
) -> None:
    from app.services.config.messages import ConfigChangedEvent

    service, fakes = lifecycle_service
    service._is_runtime_enabled = AsyncMock(return_value=False)
    await service.start()
    assert service._runtime_state == "inactive"
    service._enabled_config_path = Mock(return_value="services.lifecycle.enabled")

    lookup_entered = asyncio.Event()
    release_lookup = asyncio.Event()

    async def held_enabled_lookup() -> bool:
        lookup_entered.set()
        await release_lookup.wait()
        return True

    service._is_runtime_enabled = AsyncMock(side_effect=held_enabled_lookup)
    callback = asyncio.create_task(
        service._handle_config_changed(
            ConfigChangedEvent(
                key_path="services.lifecycle.enabled",
                affected_sections=["services.lifecycle", "services.lifecycle.enabled"],
                old_value=False,
                new_value=True,
            )
        )
    )
    stop_task: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(lookup_entered.wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        stop_task = asyncio.create_task(service.stop())
        await _wait_for_generation_change(service, previous_generation)
        await stop_task

        release_lookup.set()
        await callback

        assert service._runtime_state == "stopped"
        assert service._started is False
        assert service.start_calls == 0
        assert service.resource_owner is None
        assert fakes["announce"].await_count == 0
        fakes["start_loop"].assert_not_called()
    finally:
        release_lookup.set()
        for task in (callback, stop_task):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (callback, stop_task) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_disabled_start_keeps_only_always_available_contracts_until_stop(
    lifecycle_service,
) -> None:
    service, fakes = lifecycle_service
    service._is_runtime_enabled = AsyncMock(return_value=False)

    await service.start()

    assert service._runtime_state == "inactive"
    assert service._started is True
    assert service.start_calls == 0
    assert service.contracts_ready is False
    fakes["subscribe"].assert_awaited_once_with(only_always_available=True)
    fakes["announce"].assert_not_awaited()
    fakes["depart"].assert_not_awaited()
    fakes["start_loop"].assert_not_called()

    await service.stop()

    assert service._runtime_state == "stopped"
    assert service._started is False
    assert service.stop_calls == 0
    fakes["announce"].assert_not_awaited()
    fakes["depart"].assert_not_awaited()
    fakes["start_loop"].assert_not_called()


@pytest.mark.asyncio
async def test_newer_enabled_lookup_retires_older_false_result(lifecycle_service) -> None:
    from app.services.config.messages import ConfigChangedEvent

    service, fakes = lifecycle_service
    await service.start()
    service._enabled_config_path = Mock(return_value="services.lifecycle.enabled")

    older_lookup_entered = asyncio.Event()
    release_older_lookup = asyncio.Event()
    lookup_count = 0

    async def ordered_enabled_lookup() -> bool:
        nonlocal lookup_count
        lookup_count += 1
        if lookup_count == 1:
            older_lookup_entered.set()
            await release_older_lookup.wait()
            return False
        return True

    service._is_runtime_enabled = AsyncMock(side_effect=ordered_enabled_lookup)
    event = ConfigChangedEvent(
        key_path="services.lifecycle.enabled",
        affected_sections=["services.lifecycle", "services.lifecycle.enabled"],
        old_value=False,
        new_value=True,
    )
    older_callback = asyncio.create_task(service._handle_config_changed(event))
    newer_callback: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(older_lookup_entered.wait(), timeout=2.0)
        newer_callback = asyncio.create_task(service._handle_config_changed(event))
        await newer_callback

        assert service._runtime_state == "active"
        assert service.start_calls == 1

        release_older_lookup.set()
        await older_callback

        assert service._runtime_state == "active"
        assert service._started is True
        assert service.resource_owner == 1
        assert service.stop_calls == 0
        assert fakes["announce"].await_count == 1
        fakes["depart"].assert_not_awaited()
    finally:
        release_older_lookup.set()
        for task in (older_callback, newer_callback):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (older_callback, newer_callback) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_lifecycle_reentry_fails_before_invalidating_owner(lifecycle_service) -> None:
    service, fakes = lifecycle_service
    service.reenter_deactivation = True
    initial_generation = service._runtime_generation

    with pytest.raises(RuntimeError, match="^reentrant lifecycle transition$"):
        await service.start()

    assert service._runtime_generation == initial_generation + 1
    assert service._runtime_state == "failed"
    assert service._started is False
    assert service.start_calls == 1
    assert service.resource_owner is None
    assert fakes["announce"].await_count == 0
    fakes["depart"].assert_not_awaited()


@pytest.mark.asyncio
async def test_stop_then_replacement_start_retires_held_announcement_owner(
    lifecycle_service,
) -> None:
    service, fakes = lifecycle_service
    announcement_entered = asyncio.Event()
    release_announcement = asyncio.Event()

    async def held_announcement(*_args, **_kwargs) -> None:
        announcement_entered.set()
        await release_announcement.wait()

    service._publish_service_announcement = AsyncMock(side_effect=held_announcement)
    original_start = asyncio.create_task(service.start())
    stop_request: asyncio.Task[None] | None = None
    replacement_start: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(announcement_entered.wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        stop_request = asyncio.create_task(service.stop())
        await _wait_for_generation_change(service, previous_generation)
        previous_generation = service._runtime_generation
        replacement_start = asyncio.create_task(service.start())
        await _wait_for_generation_change(service, previous_generation)

        release_announcement.set()
        await asyncio.gather(original_start, stop_request, replacement_start)

        assert service._runtime_state == "active"
        assert service._started is True
        assert service.start_calls == 2
        assert service.resource_owner == 2
        assert service.contracts_ready is True
        assert service._publish_service_announcement.await_count == 2
        assert fakes["start_loop"].call_count == 1
    finally:
        release_announcement.set()
        tasks = (original_start, stop_request, replacement_start)
        for task in tasks:
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*(task for task in tasks if task is not None), return_exceptions=True)


@pytest.mark.asyncio
async def test_newer_stop_during_retirement_cleanup_prevents_stale_hook_entry(
    lifecycle_service,
) -> None:
    service, _fakes = lifecycle_service

    class ConfigTrackingBus:
        def __init__(self) -> None:
            self.handlers: set[object] = set()

        async def subscribe_event(self, topic, handler) -> None:
            assert topic == ConfigMethods.UPDATED
            self.handlers.add(handler)

        def unsubscribe(self, topic, handler) -> None:
            assert topic == ConfigMethods.UPDATED
            self.handlers.discard(handler)

    bus = ConfigTrackingBus()
    service._bus = bus
    service._config_change_subscription = None
    service._subscribe_to_config_changes = BaseService._subscribe_to_config_changes.__get__(service)
    service._unsubscribe_from_config_changes = BaseService._unsubscribe_from_config_changes.__get__(
        service
    )
    service._enabled_config_path = Mock(return_value="services.lifecycle.enabled")
    await service.start()
    assert len(bus.handlers) == 1
    service.on_deactivate = AsyncMock(side_effect=RuntimeError("retire for retry"))
    await service.deactivate(reason="leave cleanup for replacement")
    assert service._runtime_resources_retired is False

    cleanup_entered = asyncio.Event()
    release_cleanup = asyncio.Event()
    original_stop = service.on_stop

    async def held_cleanup() -> None:
        cleanup_entered.set()
        await release_cleanup.wait()
        await original_stop()

    service.on_stop = held_cleanup
    replacement = asyncio.create_task(service.activate(reason="replacement"))
    stop_request: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(cleanup_entered.wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        stop_request = asyncio.create_task(service.stop())
        await _wait_for_generation_change(service, previous_generation)

        release_cleanup.set()
        await asyncio.gather(replacement, stop_request)

        assert service.start_calls == 1, "superseded activation must not enter on_start"
        assert service._runtime_state == "stopped"
        assert service._started is False
        assert service.resource_owner is None
        assert service._config_change_subscription is None
        assert bus.handlers == set()
    finally:
        release_cleanup.set()
        for task in (replacement, stop_request):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (replacement, stop_request) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_start_after_pending_deactivation_restarts_enabled_service(lifecycle_service) -> None:
    service, fakes = lifecycle_service
    await service.start()
    assert fakes["start_loop"].call_count == 1
    fakes["start_loop"].reset_mock()
    deactivation_entered = asyncio.Event()
    release_deactivation = asyncio.Event()
    original_deactivate = service.on_deactivate

    async def held_deactivation() -> None:
        deactivation_entered.set()
        await release_deactivation.wait()
        await original_deactivate()

    service.on_deactivate = held_deactivation
    deactivation = asyncio.create_task(service.deactivate(reason="controlled-deactivation"))
    replacement_start: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(deactivation_entered.wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        replacement_start = asyncio.create_task(service.start())
        await _wait_for_generation_change(service, previous_generation)

        release_deactivation.set()
        await asyncio.gather(deactivation, replacement_start)

        assert service._runtime_state == "active"
        assert service._started is True
        assert service.start_calls == 2
        assert service.resource_owner == 2
        assert service.contracts_ready is True
        assert fakes["announce"].await_count == 2
        assert fakes["start_loop"].call_count == 1
    finally:
        release_deactivation.set()
        tasks = (deactivation, replacement_start)
        for task in tasks:
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*(task for task in tasks if task is not None), return_exceptions=True)


@pytest.mark.asyncio
async def test_activate_superseding_entered_start_cleans_old_resources(lifecycle_service) -> None:
    service, fakes = lifecycle_service
    service.release[1] = asyncio.Event()
    original_start = asyncio.create_task(service.start())
    replacement: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(service.entered.setdefault(1, asyncio.Event()).wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        replacement = asyncio.create_task(service.activate(reason="successor-activation"))
        await _wait_for_generation_change(service, previous_generation)

        service.release[1].set()
        await asyncio.gather(original_start, replacement)

        assert service._runtime_state == "active"
        assert service._started is True
        assert service.start_calls == 2
        assert service.stop_calls == 1
        assert service.resource_owner == 2
        assert service.contracts_ready is True
        assert service._runtime_generation != previous_generation
        assert fakes["announce"].await_count == 1
        fakes["announce"].assert_awaited_once_with(runtime_generation=service._runtime_generation)
        assert fakes["start_loop"].call_count == 1
        assert service._runtime_retirement_pending() is False
    finally:
        service.release[1].set()
        tasks = (original_start, replacement)
        for task in tasks:
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*(task for task in tasks if task is not None), return_exceptions=True)


@pytest.mark.asyncio
async def test_stop_during_full_contract_subscription_prevents_on_start(
    lifecycle_service,
) -> None:
    service, _fakes = lifecycle_service
    service._is_runtime_enabled = AsyncMock(return_value=False)
    await service.start()
    full_subscribe_entered = asyncio.Event()
    release_full_subscribe = asyncio.Event()
    original_subscribe = service._subscribe_registered_contracts

    async def held_full_subscribe(*, only_always_available=False) -> None:
        if not only_always_available:
            full_subscribe_entered.set()
            await release_full_subscribe.wait()
        await original_subscribe(only_always_available=only_always_available)

    service._subscribe_registered_contracts = AsyncMock(side_effect=held_full_subscribe)
    activation = asyncio.create_task(service.activate(reason="stale-after-subscribe"))
    stop_request: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(full_subscribe_entered.wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        stop_request = asyncio.create_task(service.stop())
        await _wait_for_generation_change(service, previous_generation)

        release_full_subscribe.set()
        await asyncio.gather(activation, stop_request)

        assert service.start_calls == 0, "retired activation must not enter its startup hook"
        assert service._runtime_state == "stopped"
        assert service._started is False
        assert service.resource_owner is None
        assert service.contracts_ready is False
    finally:
        release_full_subscribe.set()
        for task in (activation, stop_request):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (activation, stop_request) if task is not None),
            return_exceptions=True,
        )


@pytest.mark.asyncio
async def test_enabled_callback_after_stop_reservation_cannot_supersede_stop(
    lifecycle_service,
) -> None:
    from app.services.config.messages import ConfigChangedEvent

    service, _fakes = lifecycle_service
    await service.start()
    await service.deactivate(reason="prepare callback race")
    service._enabled_config_path = Mock(return_value="services.lifecycle.enabled")
    service._is_runtime_enabled = AsyncMock(return_value=True)
    announcement_entered = asyncio.Event()
    release_announcement = asyncio.Event()

    async def held_announcement(*_args, **_kwargs) -> None:
        announcement_entered.set()
        await release_announcement.wait()

    service._publish_service_announcement = AsyncMock(side_effect=held_announcement)
    activation = asyncio.create_task(service.activate(reason="controlled-activation"))
    stop_request: asyncio.Task[None] | None = None
    callback: asyncio.Task[None] | None = None
    try:
        await asyncio.wait_for(announcement_entered.wait(), timeout=2.0)
        previous_generation = service._runtime_generation
        stop_request = asyncio.create_task(service.stop())
        await _wait_for_generation_change(service, previous_generation)
        stop_generation = service._runtime_generation
        callback = asyncio.create_task(
            service._handle_config_changed(
                ConfigChangedEvent(
                    key_path="services.lifecycle.enabled",
                    affected_sections=["services.lifecycle", "services.lifecycle.enabled"],
                    old_value=False,
                    new_value=True,
                )
            )
        )
        await asyncio.sleep(0)
        callback_finished_before_release = callback.done()
        generation_after_callback = service._runtime_generation

        release_announcement.set()
        await asyncio.gather(activation, stop_request, callback)

        assert callback_finished_before_release
        assert generation_after_callback == stop_generation
        assert service._runtime_state == "stopped"
        assert service._started is False
    finally:
        release_announcement.set()
        tasks = (activation, stop_request, callback)
        for task in tasks:
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*(task for task in tasks if task is not None), return_exceptions=True)
