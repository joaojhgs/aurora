from __future__ import annotations

import asyncio
from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from pydantic import BaseModel, Field

from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.negotiation import generate_manifest
from app.services.gateway.mesh.provider_export import (
    GrantEvidence,
    PolicySnapshot,
    RecipientEvidence,
    ServiceExportPolicy,
    canonical_bytes,
    canonical_digest,
    project_provider_export,
)
from app.services.gateway.registry_aggregator import RegistryAggregator
from app.shared.contracts.mesh_surface import (
    feature_contracts_for_module,
    feature_contracts_for_topic,
)
from app.shared.contracts.models.gateway import (
    GatewayMethods,
    MethodInfo,
    ServiceAnnouncement,
    ServiceDeparture,
    ServiceHeartbeat,
)
from app.shared.contracts.models.speech import SpeechMethodConstraints
from app.shared.contracts.models.speech_runtime import (
    SpeechStageCapabilityExportV1,
    SpeechStageCapabilityV1,
)
from app.shared.contracts.registry import (
    CallableFeatureContract,
    MethodContract,
    ModuleContract,
)
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


async def _wait_for_generation(service, generation: int) -> None:
    async def wait_until_reserved() -> None:
        while service._runtime_generation < generation:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_until_reserved(), timeout=1)


async def _wait_for_event_or_task(
    event: asyncio.Event, task: asyncio.Task, description: str
) -> None:
    event_waiter = asyncio.create_task(event.wait())
    try:
        done, _ = await asyncio.wait(
            {event_waiter, task}, timeout=1, return_when=asyncio.FIRST_COMPLETED
        )
        if not done:
            raise asyncio.TimeoutError(f"timed out waiting for {description}")
        if event_waiter not in done:
            await task
            raise AssertionError(f"operation completed before {description}")
        await event_waiter
    finally:
        if not event_waiter.done():
            event_waiter.cancel()
        await asyncio.gather(event_waiter, return_exceptions=True)


async def _finish_tasks(*tasks: asyncio.Task) -> None:
    live_tasks = [task for task in tasks if task is not None]
    if not live_tasks:
        return
    try:
        await asyncio.wait_for(asyncio.gather(*live_tasks, return_exceptions=True), timeout=1)
    except asyncio.TimeoutError:
        for task in live_tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*live_tasks, return_exceptions=True)


class _ParityInput(BaseModel):
    query: str
    weights: dict[str, list[int]] = Field(default_factory=dict)


class _ParityOutput(BaseModel):
    accepted: bool
    labels: list[str] = Field(default_factory=list)


def _announcement(*, schema_title: str = "Input", tag: str = "alpha") -> ServiceAnnouncement:
    return ServiceAnnouncement(
        module="Gateway",
        version="1.0.0",
        capabilities=[tag],
        methods=[
            MethodInfo(
                name="Speak",
                bus_topic="Gateway.GetServices",
                exposure="both",
                method_type="use",
                required_perms=["Gateway.GetServices"],
                input_model="Input",
                output_model="Output",
                input_schema={"type": "object", "title": schema_title},
                output_schema={"type": "object", "title": "Output"},
            )
        ],
    )


def _ready_speech_export(*, revision: int = 1) -> SpeechStageCapabilityExportV1:
    capability = SpeechStageCapabilityV1(
        stage="tts",
        method_ids=["TTS.Synthesize"],
        modes=["finite"],
        implementation="python",
        peer_id="speech-fixture-peer",
        capability_revision=revision,
        lifecycle=["foreground"],
        readiness="ready",
        exported=True,
    )
    return SpeechStageCapabilityExportV1(
        capability=capability,
        voice_ids=["standard:test:voice-a"],
    )


def _speech_fixture_module() -> ModuleContract:
    return ModuleContract(
        module="SpeechRuntimeFixture",
        version="1.0.0",
        summary="Speech runtime fixture",
        methods=[],
    )


def test_legacy_service_announcement_defaults_to_no_runtime_speech_projection() -> None:
    announcement = ServiceAnnouncement.model_validate(
        {"module": "LegacyFixture", "version": "1.0.0"}
    )

    assert announcement.speech_stage_capabilities == []


@pytest.mark.asyncio
async def test_base_service_runtime_speech_hook_defaults_to_empty() -> None:
    from app.shared.services.base_service import BaseService

    class DefaultHookService(BaseService):
        async def on_start(self) -> None:
            return None

        async def on_stop(self) -> None:
            return None

        async def reload(self, config_section: str | None = None) -> None:
            return None

    service = DefaultHookService("DefaultSpeechHookFixture")

    assert await service._speech_stage_capabilities_for_announcement() == []


@pytest.mark.asyncio
async def test_base_service_announcement_includes_runtime_hook_after_start() -> None:
    from app.shared.services.base_service import BaseService

    order: list[str] = []

    class CaptureBus:
        def __init__(self) -> None:
            self.announcements: list[ServiceAnnouncement] = []

        async def publish(self, topic, payload, **_kwargs) -> None:
            if topic == GatewayMethods.SERVICE_ANNOUNCE:
                self.announcements.append(payload)

    class SpeechAnnouncementService(BaseService):
        def __init__(self) -> None:
            self.capture_bus = CaptureBus()
            super().__init__("SpeechRuntimeFixture", summary="Speech fixture")

        @property
        def bus(self):
            return self.capture_bus

        async def _is_runtime_enabled(self) -> bool:
            return True

        async def _subscribe_registered_contracts(self, only_always_available=False) -> None:
            return None

        def _start_gateway_announcement_loop(self, runtime_generation=None) -> None:
            return None

        async def on_start(self) -> None:
            order.append("started")

        async def on_stop(self) -> None:
            return None

        async def reload(self, config_section: str | None = None) -> None:
            return None

        async def _speech_stage_capabilities_for_announcement(self):
            assert order == ["started"]
            order.append("projected")
            return [_ready_speech_export()]

    service = SpeechAnnouncementService()
    await service.activate()

    assert order == ["started", "projected"]
    assert len(service.capture_bus.announcements) == 1
    assert service.capture_bus.announcements[0].speech_stage_capabilities == [
        _ready_speech_export()
    ]


@pytest.mark.asyncio
async def test_thread_static_refresh_preserves_latest_runtime_projection_and_detaches_input(
    monkeypatch,
) -> None:
    import app.shared.contracts.registry as contract_registry

    module = _speech_fixture_module()
    monkeypatch.setattr(contract_registry, "list_modules", lambda: {module.module: module})
    thread_registry = RegistryAggregator(bus=SimpleNamespace(), mode="threads")
    process_registry = RegistryAggregator(bus=SimpleNamespace(), mode="processes")
    await thread_registry._load_from_local_registry()

    for revision in (1, 2):
        announcement = ServiceAnnouncement(
            module=module.module,
            version=module.version,
            summary=module.summary,
            speech_stage_capabilities=[_ready_speech_export(revision=revision)],
        )
        payload = announcement.model_dump(mode="json")
        await process_registry._on_service_announce(SimpleNamespace(payload=payload))
        await thread_registry._on_service_announce(SimpleNamespace(payload=payload))
        payload["speech_stage_capabilities"][0]["voice_ids"].append(
            "standard:test:mutated-after-publication"
        )

    process_services = process_registry.snapshot_services()
    await thread_registry._load_from_local_registry()
    thread_services = thread_registry.snapshot_services()

    process_projection = process_services[module.module].speech_stage_capabilities
    thread_projection = thread_services[module.module].speech_stage_capabilities
    assert thread_projection[0].capability.capability_revision == 2
    assert thread_projection[0].voice_ids == ("standard:test:voice-a",)
    assert thread_projection == process_projection

    expected_projection = tuple(process_projection)
    process_services[module.module].speech_stage_capabilities.clear()
    thread_services[module.module].speech_stage_capabilities.clear()
    assert process_registry.snapshot_services()[module.module].speech_stage_capabilities == list(
        expected_projection
    )
    assert thread_registry.snapshot_services()[module.module].speech_stage_capabilities == list(
        expected_projection
    )


@pytest.mark.asyncio
async def test_runtime_hook_failure_publishes_empty_projection_and_clears_ready_snapshot() -> None:
    from app.shared.services.base_service import BaseService

    registry = RegistryAggregator(bus=SimpleNamespace(), mode="processes")

    class RegistryBus:
        async def publish(self, topic, payload, **_kwargs) -> None:
            if topic == GatewayMethods.SERVICE_ANNOUNCE:
                await registry._on_service_announce(SimpleNamespace(payload=payload))

    class SometimesUnavailableService(BaseService):
        def __init__(self) -> None:
            self.registry_bus = RegistryBus()
            self.fail_hook = False
            super().__init__("SpeechRuntimeFixture", summary="Speech fixture")

        @property
        def bus(self):
            return self.registry_bus

        async def _is_runtime_enabled(self) -> bool:
            return True

        async def _subscribe_registered_contracts(self, only_always_available=False) -> None:
            return None

        def _start_gateway_announcement_loop(self, runtime_generation=None) -> None:
            return None

        async def on_start(self) -> None:
            return None

        async def on_stop(self) -> None:
            return None

        async def reload(self, config_section: str | None = None) -> None:
            return None

        async def _speech_stage_capabilities_for_announcement(self):
            if self.fail_hook:
                raise RuntimeError("runtime readiness unavailable")
            return [_ready_speech_export()]

    service = SometimesUnavailableService()
    await service.activate()
    assert registry.snapshot_services()["SpeechRuntimeFixture"].speech_stage_capabilities

    service.fail_hook = True
    await service._publish_service_announcement()

    assert registry.snapshot_services()["SpeechRuntimeFixture"].speech_stage_capabilities == []


@pytest.mark.asyncio
async def test_stale_runtime_hook_cannot_publish_after_deactivate_and_reactivate() -> None:
    from app.shared.services.base_service import BaseService

    first_hook_started = asyncio.Event()
    release_first_hook = asyncio.Event()

    class CaptureBus:
        def __init__(self) -> None:
            self.announcements: list[ServiceAnnouncement] = []

        async def publish(self, topic, payload, **_kwargs) -> None:
            if topic == GatewayMethods.SERVICE_ANNOUNCE:
                self.announcements.append(payload)

    class ReentrantProjectionService(BaseService):
        def __init__(self) -> None:
            self.capture_bus = CaptureBus()
            self.hook_calls = 0
            super().__init__("SpeechRuntimeFixture", summary="Speech fixture")

        @property
        def bus(self):
            return self.capture_bus

        async def _is_runtime_enabled(self) -> bool:
            return True

        async def _subscribe_registered_contracts(self, only_always_available=False) -> None:
            return None

        def _start_gateway_announcement_loop(self, runtime_generation=None) -> None:
            return None

        async def on_start(self) -> None:
            return None

        async def on_stop(self) -> None:
            return None

        async def reload(self, config_section: str | None = None) -> None:
            return None

        async def _speech_stage_capabilities_for_announcement(self):
            self.hook_calls += 1
            if self.hook_calls == 1:
                first_hook_started.set()
                await release_first_hook.wait()
                return [_ready_speech_export(revision=1)]
            return [_ready_speech_export(revision=2)]

    service = ReentrantProjectionService()
    stale_activation = asyncio.create_task(service.activate())
    deactivation: asyncio.Task[None] | None = None
    replacement_activation: asyncio.Task[None] | None = None
    try:
        await _wait_for_event_or_task(first_hook_started, stale_activation, "first projection hook")
        generation = service._runtime_generation
        deactivation = asyncio.create_task(service.deactivate())
        await _wait_for_generation(service, generation + 1)
        replacement_activation = asyncio.create_task(service.activate())
        await _wait_for_generation(service, generation + 2)

        release_first_hook.set()
        await asyncio.wait_for(stale_activation, timeout=1)
        assert deactivation is not None
        assert replacement_activation is not None
        await asyncio.wait_for(deactivation, timeout=1)
        await asyncio.wait_for(replacement_activation, timeout=1)
    finally:
        release_first_hook.set()
        tasks = [stale_activation]
        if deactivation is not None:
            tasks.append(deactivation)
        if replacement_activation is not None:
            tasks.append(replacement_activation)
        await _finish_tasks(*tasks)

    assert service.hook_calls == 2
    assert len(service.capture_bus.announcements) == 1
    assert (
        service.capture_bus.announcements[0]
        .speech_stage_capabilities[0]
        .capability.capability_revision
        == 2
    )


@pytest.mark.asyncio
async def test_retired_activation_cannot_start_announcement_loop_before_replacement_hook_completes() -> (
    None
):
    from app.shared.services.base_service import BaseService

    first_hook_started = asyncio.Event()
    second_hook_started = asyncio.Event()
    release_first_hook = asyncio.Event()
    release_second_hook = asyncio.Event()

    class CaptureBus:
        def __init__(self) -> None:
            self.announcements: list[ServiceAnnouncement] = []

        async def publish(self, topic, payload, **_kwargs) -> None:
            if topic == GatewayMethods.SERVICE_ANNOUNCE:
                self.announcements.append(payload)

    class DelayedReplacementService(BaseService):
        def __init__(self) -> None:
            self.capture_bus = CaptureBus()
            self.hook_calls = 0
            self.announcement_loop_starts = 0
            super().__init__("SpeechRuntimeFixture", summary="Speech fixture")

        @property
        def bus(self):
            return self.capture_bus

        async def _is_runtime_enabled(self) -> bool:
            return True

        async def _subscribe_registered_contracts(self, only_always_available=False) -> None:
            return None

        def _start_gateway_announcement_loop(self, runtime_generation=None) -> None:
            self.announcement_loop_starts += 1

        async def on_start(self) -> None:
            return None

        async def on_stop(self) -> None:
            return None

        async def reload(self, config_section: str | None = None) -> None:
            return None

        async def _speech_stage_capabilities_for_announcement(self):
            self.hook_calls += 1
            if self.hook_calls == 1:
                first_hook_started.set()
                await release_first_hook.wait()
                return [_ready_speech_export(revision=1)]
            second_hook_started.set()
            await release_second_hook.wait()
            return [_ready_speech_export(revision=2)]

    service = DelayedReplacementService()
    retired_activation = asyncio.create_task(service.activate())
    deactivation: asyncio.Task[None] | None = None
    replacement_activation: asyncio.Task[None] | None = None
    try:
        await _wait_for_event_or_task(
            first_hook_started, retired_activation, "first projection hook"
        )
        generation = service._runtime_generation
        deactivation = asyncio.create_task(service.deactivate())
        await _wait_for_generation(service, generation + 1)
        replacement_activation = asyncio.create_task(service.activate())
        await _wait_for_generation(service, generation + 2)

        assert service.hook_calls == 1
        assert service.announcement_loop_starts == 0
        assert service.capture_bus.announcements == []

        release_first_hook.set()
        await asyncio.wait_for(retired_activation, timeout=1)
        assert service.announcement_loop_starts == 0
        assert service.capture_bus.announcements == []
        assert replacement_activation is not None
        await _wait_for_event_or_task(
            second_hook_started, replacement_activation, "replacement projection hook"
        )
        assert service.announcement_loop_starts == 0
        assert service.capture_bus.announcements == []
        release_second_hook.set()
        assert deactivation is not None
        assert replacement_activation is not None
        await asyncio.wait_for(deactivation, timeout=1)
        await asyncio.wait_for(replacement_activation, timeout=1)
    finally:
        release_first_hook.set()
        release_second_hook.set()
        tasks = [retired_activation]
        if deactivation is not None:
            tasks.append(deactivation)
        if replacement_activation is not None:
            tasks.append(replacement_activation)
        await _finish_tasks(*tasks)

    assert replacement_activation is not None
    assert service.announcement_loop_starts == 1
    assert len(service.capture_bus.announcements) == 1
    assert (
        service.capture_bus.announcements[0]
        .speech_stage_capabilities[0]
        .capability.capability_revision
        == 2
    )


@pytest.mark.asyncio
async def test_registry_snapshot_revision_changes_only_for_contract_content() -> None:
    aggregator = RegistryAggregator(bus=SimpleNamespace())

    await aggregator._on_service_announce(SimpleNamespace(payload=_announcement()))
    first = aggregator.snapshot_registry()
    await aggregator._on_service_announce(SimpleNamespace(payload=_announcement()))
    identical = aggregator.snapshot_registry()
    await aggregator._on_service_heartbeat(
        SimpleNamespace(payload=ServiceHeartbeat(module="Gateway"))
    )
    heartbeat = aggregator.snapshot_registry()
    await aggregator._on_service_announce(
        SimpleNamespace(payload=_announcement(schema_title="Changed"))
    )
    changed = aggregator.snapshot_registry()

    assert first.revision == identical.revision == heartbeat.revision
    assert first.digest == identical.digest == heartbeat.digest
    assert changed.revision != first.revision
    assert changed.digest != first.digest


@pytest.mark.asyncio
async def test_depart_and_stale_prune_replace_snapshot_only_when_present() -> None:
    aggregator = RegistryAggregator(
        bus=SimpleNamespace(),
        mode="processes",
        heartbeat_timeout_s=1,
    )
    changes: list[str] = []
    aggregator.on_registry_change(lambda: changes.append("changed"))
    await aggregator._on_service_announce(SimpleNamespace(payload=_announcement()))
    announced = aggregator.snapshot_registry()

    await aggregator._on_service_depart(SimpleNamespace(payload=ServiceDeparture(module="Missing")))
    absent_depart = aggregator.snapshot_registry()

    assert absent_depart is announced
    assert changes == ["changed"]

    await aggregator._on_service_depart(SimpleNamespace(payload=ServiceDeparture(module="Gateway")))
    departed = aggregator.snapshot_registry()
    assert departed is not announced
    assert int(departed.revision) == int(announced.revision) + 1
    assert changes == ["changed", "changed"]

    await aggregator._on_service_announce(SimpleNamespace(payload=_announcement()))
    reannounced = aggregator.snapshot_registry()
    aggregator._last_seen["Gateway"] = datetime.utcnow() - timedelta(seconds=3)
    assert await aggregator.prune_stale_services() == ["Gateway"]
    pruned = aggregator.snapshot_registry()

    assert pruned is not reannounced
    assert int(pruned.revision) == int(reannounced.revision) + 1
    assert changes == ["changed", "changed", "changed", "changed"]


@pytest.mark.asyncio
async def test_thread_refresh_conversion_failure_keeps_previous_snapshot(monkeypatch) -> None:
    import app.shared.contracts.registry as contract_registry

    module = ModuleContract(
        module="Gateway",
        version="1.0.0",
        methods=[
            MethodContract(
                module="Gateway",
                module_version="1.0.0",
                name="GetServices",
                bus_topic="Gateway.GetServices",
                required_perms=["Gateway.GetServices"],
                input_model=_ParityInput,
                output_model=_ParityOutput,
                exposure="both",
            )
        ],
    )
    modules: dict[str, object] = {"Gateway": module}
    monkeypatch.setattr(contract_registry, "list_modules", lambda: modules)
    aggregator = RegistryAggregator(bus=SimpleNamespace(), mode="threads")
    await aggregator._load_from_local_registry()
    baseline = aggregator.snapshot_registry()

    class BrokenModule:
        @property
        def methods(self):
            raise RuntimeError("conversion failed")

    modules = {
        "Gateway": module.model_copy(update={"version": "2.0.0"}),
        "Broken": BrokenModule(),
    }
    await aggregator._load_from_local_registry()

    assert aggregator.snapshot_registry() is baseline
    assert aggregator.snapshot_services()["Gateway"].version == "1.0.0"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "invalid_announcement",
    [
        _announcement().model_copy(update={"version": " "}),
        _announcement().model_copy(update={"capabilities": ["alpha", "alpha"]}),
    ],
)
async def test_process_announcement_canonical_rejection_keeps_live_and_snapshot_state(
    invalid_announcement: ServiceAnnouncement,
) -> None:
    aggregator = RegistryAggregator(
        bus=SimpleNamespace(),
        mode="processes",
        heartbeat_timeout_s=1,
    )
    changes: list[str] = []
    aggregator.on_registry_change(lambda: changes.append("changed"))

    await aggregator._on_service_announce(SimpleNamespace(payload=_announcement()))
    assert changes == ["changed"]
    changes.clear()

    legacy_last_seen = datetime(2026, 1, 1)
    aggregator._last_seen["Gateway"] = legacy_last_seen
    legacy_live = aggregator.snapshot_services()["Gateway"]
    legacy_snapshot = aggregator.snapshot_registry()
    legacy_revision = aggregator._registry_revision
    legacy_fingerprint = aggregator._registry_content_digest
    legacy_digest = legacy_snapshot.digest
    legacy_canonical = canonical_bytes(legacy_snapshot)

    await aggregator._on_service_announce(SimpleNamespace(payload=invalid_announcement))

    current_live = aggregator.snapshot_services()["Gateway"]
    current_snapshot = aggregator.snapshot_registry()
    assert current_live.version == legacy_live.version == "1.0.0"
    assert current_live.capabilities == legacy_live.capabilities == ["alpha"]
    assert current_snapshot is legacy_snapshot
    assert current_snapshot.digest == legacy_digest
    assert canonical_bytes(current_snapshot) == legacy_canonical
    assert aggregator._registry_revision == legacy_revision
    assert aggregator._registry_content_digest == legacy_fingerprint
    assert aggregator._last_seen["Gateway"] == legacy_last_seen
    assert changes == []


def test_registry_snapshot_is_immutable_and_binds_schema_tags_and_permissions() -> None:
    aggregator = RegistryAggregator(bus=SimpleNamespace())
    aggregator._services["Gateway"] = _announcement()
    aggregator._refresh_registry_snapshot_locked()

    snapshot = aggregator.snapshot_registry()
    method = snapshot.services[0].methods[0]
    baseline = snapshot.digest

    assert method.input_schema_hash == canonical_digest(method.input_schema)
    assert method.output_schema_hash == canonical_digest(method.output_schema)
    assert method.speech_constraints is None
    assert snapshot.services[0].capacity_present is False
    assert dict(snapshot.services[0].capacity) == {}
    with pytest.raises(FrozenInstanceError):
        method.topic = "Gateway.GetRoutes"  # type: ignore[misc]
    with pytest.raises(TypeError):
        method.input_schema["title"] = "Mutated"  # type: ignore[index]

    for mutation in (
        _announcement(schema_title="Other"),
        ServiceAnnouncement(
            module="Gateway",
            version="1.0.0",
            capabilities=["beta"],
            methods=_announcement().methods,
        ),
        ServiceAnnouncement(
            module="Gateway",
            version="1.0.0",
            capabilities=["alpha"],
            methods=[
                MethodInfo(
                    name="Speak",
                    bus_topic="Gateway.GetServices",
                    exposure="both",
                    method_type="use",
                    required_perms=["Gateway.GetRoutes"],
                    input_model="Input",
                    output_model="Output",
                    input_schema={"type": "object", "title": "Input"},
                    output_schema={"type": "object", "title": "Output"},
                )
            ],
        ),
        ServiceAnnouncement(
            module="Gateway",
            version="1.0.0",
            capabilities=["alpha"],
            callable_features=[
                CallableFeatureContract(
                    feature_id="gateway_read",
                    module="Gateway",
                    method_ids=("Gateway.GetServices",),
                )
            ],
            methods=[
                _announcement()
                .methods[0]
                .model_copy(update={"callable_feature_ids": ["gateway_read"]})
            ],
        ),
    ):
        other = RegistryAggregator(bus=SimpleNamespace())
        other._services["Gateway"] = mutation
        other._refresh_registry_snapshot_locked()
        assert other.snapshot_registry().digest != baseline


@pytest.mark.asyncio
async def test_thread_process_snapshot_manifest_and_projection_bytes_match(
    monkeypatch,
) -> None:
    import app.shared.contracts.registry as contract_registry

    constraints = SpeechMethodConstraints(
        exact_languages=["en", "de"],
        ready_voice_ids=["standard:test:voice-a"],
        resident_model_identity_digest="f" * 64,
        speech_capability_revision=9,
    )
    feature = feature_contracts_for_topic("TTS.Synthesize")[0]
    method_contract = MethodContract(
        module="TTS",
        module_version="1.0.0",
        name="Synthesize",
        summary="Synthesize audio",
        bus_topic="TTS.Synthesize",
        required_perms=["TTS.Synthesize"],
        callable_feature_ids=["speech_synthesis"],
        callable_features=[feature],
        public_infrastructure=False,
        method_type="use",
        input_model=_ParityInput,
        output_model=_ParityOutput,
        speech_constraints=constraints,
        exposure="both",
    )
    module_contract = ModuleContract(
        module="TTS",
        version="1.0.0",
        summary="TTS service",
        capabilities=["zeta", "alpha"],
        methods=[method_contract],
        callable_features=list(feature_contracts_for_module("TTS")),
    )
    monkeypatch.setattr(
        contract_registry,
        "list_modules",
        lambda: {"TTS": module_contract},
    )

    thread_registry = RegistryAggregator(bus=SimpleNamespace(), mode="threads")
    process_registry = RegistryAggregator(bus=SimpleNamespace(), mode="processes")
    await thread_registry._load_from_local_registry()
    process_announcement = ServiceAnnouncement(
        module="TTS",
        version="1.0.0",
        summary="TTS service",
        capabilities=["alpha", "zeta"],
        callable_features=list(feature_contracts_for_module("TTS")),
        methods=[
            MethodInfo(
                name="Synthesize",
                summary="Synthesize audio",
                bus_topic="TTS.Synthesize",
                exposure="both",
                input_model=_ParityInput.__name__,
                output_model=_ParityOutput.__name__,
                required_perms=["TTS.Synthesize"],
                callable_feature_ids=["speech_synthesis"],
                callable_features=[feature],
                public_infrastructure=False,
                method_type="use",
                speech_constraints=constraints,
                input_schema=_ParityInput.model_json_schema(),
                output_schema=_ParityOutput.model_json_schema(),
            )
        ],
    )
    await process_registry._on_service_announce(
        SimpleNamespace(payload=process_announcement.model_dump(mode="json"))
    )

    thread_snapshot = thread_registry.snapshot_registry()
    process_snapshot = process_registry.snapshot_registry()
    assert thread_snapshot.revision == process_snapshot.revision == "1"
    assert thread_snapshot.services[0].methods[0].input_schema == (
        process_snapshot.services[0].methods[0].input_schema
    )
    assert thread_snapshot.services[0].methods[0].output_schema == (
        process_snapshot.services[0].methods[0].output_schema
    )
    assert thread_snapshot.services[0].methods[0].speech_constraints == (
        process_snapshot.services[0].methods[0].speech_constraints
    )

    mesh_config = MeshConfig(
        enabled=True,
        services={"TTS": mesh_policy(share=True, max_concurrent=4)},
    )
    thread_manifest = generate_manifest("provider", mesh_config, registry=thread_registry)
    process_manifest = generate_manifest("provider", mesh_config, registry=process_registry)

    assert thread_manifest.model_dump(exclude={"timestamp"}) == process_manifest.model_dump(
        exclude={"timestamp"}
    )
    assert canonical_bytes(thread_snapshot) == canonical_bytes(process_snapshot)

    policy = PolicySnapshot(
        revision="1",
        services=(ServiceExportPolicy(service_id="TTS", share=True, max_concurrent=4),),
    )
    recipient = RecipientEvidence(
        peer_id="recipient",
        revision=1,
        grants=(GrantEvidence("TTS.Synthesize"),),
    )
    thread_projection = project_provider_export(
        provider_peer_id="provider",
        registry=thread_snapshot,
        policy=policy,
        recipient=recipient,
    )
    process_projection = project_provider_export(
        provider_peer_id="provider",
        registry=process_snapshot,
        policy=policy,
        recipient=recipient,
    )

    assert thread_projection.canonical == process_projection.canonical
    assert thread_projection.digest == process_projection.digest
    assert thread_projection.services[0].capacity == {"max_concurrent": 4}
