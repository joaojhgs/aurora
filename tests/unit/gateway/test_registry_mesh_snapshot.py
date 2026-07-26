from __future__ import annotations

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
from app.shared.contracts.models.gateway import (
    MethodInfo,
    ServiceAnnouncement,
    ServiceDeparture,
    ServiceHeartbeat,
)
from app.shared.contracts.registry import (
    CallableFeatureContract,
    MethodContract,
    ModuleContract,
)
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


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

    feature = CallableFeatureContract(
        feature_id="gateway_read",
        module="Gateway",
        label="Gateway Read",
        summary="Read the gateway inventory.",
        method_ids=("Gateway.GetServices",),
    )
    method_contract = MethodContract(
        module="Gateway",
        module_version="1.0.0",
        name="GetServices",
        summary="Get service inventory",
        bus_topic="Gateway.GetServices",
        required_perms=["Gateway.Read", "Gateway.GetServices"],
        callable_feature_ids=["gateway_read"],
        callable_features=[feature],
        public_infrastructure=False,
        method_type="use",
        input_model=_ParityInput,
        output_model=_ParityOutput,
        exposure="both",
    )
    module_contract = ModuleContract(
        module="Gateway",
        version="1.0.0",
        summary="Gateway service",
        capabilities=["zeta", "alpha"],
        methods=[method_contract],
        callable_features=[feature],
    )
    monkeypatch.setattr(
        contract_registry,
        "list_modules",
        lambda: {"Gateway": module_contract},
    )

    thread_registry = RegistryAggregator(bus=SimpleNamespace(), mode="threads")
    process_registry = RegistryAggregator(bus=SimpleNamespace(), mode="processes")
    await thread_registry._load_from_local_registry()
    process_announcement = ServiceAnnouncement(
        module="Gateway",
        version="1.0.0",
        summary="Gateway service",
        capabilities=["alpha", "zeta"],
        callable_features=[feature],
        methods=[
            MethodInfo(
                name="GetServices",
                summary="Get service inventory",
                bus_topic="Gateway.GetServices",
                exposure="both",
                input_model=_ParityInput.__name__,
                output_model=_ParityOutput.__name__,
                required_perms=["Gateway.GetServices", "Gateway.Read"],
                callable_feature_ids=["gateway_read"],
                callable_features=[feature],
                public_infrastructure=False,
                method_type="use",
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

    mesh_config = MeshConfig(
        enabled=True,
        services={"Gateway": mesh_policy(share=True, max_concurrent=4)},
    )
    thread_manifest = generate_manifest("provider", mesh_config, registry=thread_registry)
    process_manifest = generate_manifest("provider", mesh_config, registry=process_registry)

    assert thread_manifest.model_dump(exclude={"timestamp"}) == process_manifest.model_dump(
        exclude={"timestamp"}
    )
    assert canonical_bytes(thread_snapshot) == canonical_bytes(process_snapshot)

    policy = PolicySnapshot(
        revision="1",
        services=(ServiceExportPolicy(service_id="Gateway", share=True, max_concurrent=4),),
    )
    recipient = RecipientEvidence(
        peer_id="recipient",
        revision=1,
        grants=(GrantEvidence("Gateway.GetServices"), GrantEvidence("Gateway.Read")),
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
