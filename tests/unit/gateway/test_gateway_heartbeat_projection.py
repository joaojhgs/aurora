from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.messaging.bus import Envelope
from app.services.gateway.registry_aggregator import RegistryAggregator
from app.services.gateway.service import (
    _SERVICE_ANNOUNCEMENT_DIGEST_CACHE_MAX,
    GatewayService,
)
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.gateway import GatewayMethods


def _announcement_payload() -> dict[str, object]:
    return {
        "module": "RuntimeAnnouncement",
        "version": "1.0.0",
        "capabilities": ["speech"],
        "instance_id": "runtime-a",
        "timestamp": "2026-09-18T00:00:00+00:00",
        "methods": [
            {
                "name": "Synthesize",
                "bus_topic": "RuntimeAnnouncement.Synthesize",
                "method_type": "use",
                "speech_constraints": {
                    "exact_languages": ["en-US"],
                    "ready_voice_ids": ["standard:runtime:en"],
                    "resident_model_identity_digest": "a" * 64,
                    "speech_capability_revision": 1,
                },
            }
        ],
    }


@pytest.mark.unit
def test_service_heartbeat_burst_does_not_project_topology_status() -> None:
    """Routine liveness traffic must not refresh the service topology."""
    assert all(
        GatewayService._status_changed_event(
            GatewayMethods.SERVICE_HEARTBEAT,
            {"module": "Tooling", "heartbeat": sequence},
        )
        is None
        for sequence in range(8)
    )

    announced = GatewayService._status_changed_event(
        GatewayMethods.SERVICE_ANNOUNCE, {"module": "Tooling"}
    )
    departed = GatewayService._status_changed_event(
        GatewayMethods.SERVICE_DEPART, {"module": "Tooling"}
    )
    config_changed = GatewayService._status_changed_event(
        ConfigMethods.UPDATED, {"key_path": "services.tts"}
    )

    assert announced is not None and announced.kind == "service.announced"
    assert departed is not None and departed.kind == "service.stale"
    assert config_changed is not None and config_changed.kind == "config.updated"


@pytest.mark.unit
def test_service_announcement_renewals_dedupe_but_changes_and_departures_emit() -> None:
    service = GatewayService()
    announcement = {
        "module": "Tooling",
        "version": "1.0.0",
        "capabilities": ["tools"],
        "instance_id": "tooling-a",
        "timestamp": "2026-09-18T00:00:00+00:00",
    }

    first = service._status_event_for_payload(GatewayMethods.SERVICE_ANNOUNCE, announcement)
    assert first is not None and first.kind == "service.announced"

    renewal = {**announcement, "timestamp": "2026-09-18T00:00:30+00:00"}
    assert service._status_event_for_payload(GatewayMethods.SERVICE_ANNOUNCE, renewal) is None

    changed = {**renewal, "capabilities": ["tools", "speech"]}
    assert service._status_event_for_payload(GatewayMethods.SERVICE_ANNOUNCE, changed) is not None

    restarted = {**changed, "instance_id": "tooling-b"}
    assert service._status_event_for_payload(GatewayMethods.SERVICE_ANNOUNCE, restarted) is not None

    departed = service._status_event_for_payload(
        GatewayMethods.SERVICE_DEPART,
        {"module": "Tooling", "instance_id": "tooling-b"},
    )
    assert departed is not None and departed.kind == "service.stale"
    assert service._status_event_for_payload(GatewayMethods.SERVICE_ANNOUNCE, renewal) is not None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_announcement_handler_updates_lease_while_status_projection_dedupes() -> None:
    bus = AsyncMock()
    aggregator = RegistryAggregator(bus, mode="processes")
    service = GatewayService()
    service.bus.publish = AsyncMock()
    announcement = _announcement_payload()
    envelope = Envelope(type=GatewayMethods.SERVICE_ANNOUNCE, payload=announcement)

    await aggregator._on_service_announce(envelope)
    await service._capture_gateway_event(envelope)
    first_seen = aggregator._last_seen["RuntimeAnnouncement"]
    assert await aggregator.get_service("RuntimeAnnouncement") is not None
    assert [
        call
        for call in service.bus.publish.await_args_list
        if call.args[0] == GatewayMethods.STATUS_CHANGED
    ]

    renewal = {**announcement, "timestamp": "2026-09-18T00:00:30+00:00"}
    renewal_envelope = Envelope(type=GatewayMethods.SERVICE_ANNOUNCE, payload=renewal)
    await aggregator._on_service_announce(renewal_envelope)
    await service._capture_gateway_event(renewal_envelope)
    assert aggregator._last_seen["RuntimeAnnouncement"] is not first_seen
    assert not [
        call
        for call in service.bus.publish.await_args_list[2:]
        if call.args[0] == GatewayMethods.STATUS_CHANGED
    ]

    changed = {
        **renewal,
        "version": "2.0.0",
        "instance_id": "runtime-b",
        "capabilities": ["speech", "ready"],
        "methods": [
            {
                **announcement["methods"][0],
                "summary": "ready",
                "speech_constraints": {
                    **announcement["methods"][0]["speech_constraints"],
                    "speech_capability_revision": 2,
                },
            }
        ],
    }
    changed_envelope = Envelope(type=GatewayMethods.SERVICE_ANNOUNCE, payload=changed)
    await aggregator._on_service_announce(changed_envelope)
    await service._capture_gateway_event(changed_envelope)
    updated = await aggregator.get_service("RuntimeAnnouncement")
    assert updated is not None
    assert updated.version == "2.0.0"
    assert updated.instance_id == "runtime-b"
    assert updated.methods[0].speech_constraints is not None
    assert updated.methods[0].speech_constraints.speech_capability_revision == 2
    assert (
        len(
            [
                call
                for call in service.bus.publish.await_args_list
                if call.args[0] == GatewayMethods.STATUS_CHANGED
            ]
        )
        == 2
    )

    departure = Envelope(
        type=GatewayMethods.SERVICE_DEPART,
        payload={"module": "RuntimeAnnouncement", "instance_id": "runtime-b"},
    )
    await aggregator._on_service_depart(departure)
    await service._capture_gateway_event(departure)
    assert await aggregator.get_service("RuntimeAnnouncement") is None
    assert (
        len(
            [
                call
                for call in service.bus.publish.await_args_list
                if call.args[0] == GatewayMethods.STATUS_CHANGED
            ]
        )
        == 3
    )

    await aggregator._on_service_announce(envelope)
    await service._capture_gateway_event(envelope)
    assert (
        len(
            [
                call
                for call in service.bus.publish.await_args_list
                if call.args[0] == GatewayMethods.STATUS_CHANGED
            ]
        )
        == 4
    )


@pytest.mark.unit
def test_service_announcement_digest_cache_has_a_stable_bound() -> None:
    service = GatewayService()
    for index in range(_SERVICE_ANNOUNCEMENT_DIGEST_CACHE_MAX + 1):
        service._status_event_for_payload(
            GatewayMethods.SERVICE_ANNOUNCE,
            {
                "module": f"RuntimeAnnouncement-{index}",
                "version": "1.0.0",
                "timestamp": f"2026-09-18T00:00:{index:02d}+00:00",
            },
        )

    assert len(service._service_announcement_projection_digests) == (
        _SERVICE_ANNOUNCEMENT_DIGEST_CACHE_MAX
    )
