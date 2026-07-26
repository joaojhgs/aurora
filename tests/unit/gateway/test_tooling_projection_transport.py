import json
from collections import OrderedDict
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.messaging.bus import Envelope, QueryResult
from app.services.gateway.acl.identity import Identity
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.tooling_projection_transport import (
    TOOLING_PROJECTION_INVALIDATED_TOPIC,
    TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC,
    bind_invalidation_to_authenticated_provider,
    select_tooling_protocol,
)
from app.services.gateway.service import GatewayService
from app.services.gateway.webrtc.rpc import RPCHandler
from app.services.gateway.webrtc.rtc_client import RTCClient
from app.shared.contracts.models.gateway import GatewayFetchToolingExportCatalogPageRequest
from app.shared.contracts.models.tooling import (
    ToolingGetExportCatalogRequest,
    ToolingGetExportCatalogResponse,
    ToolingMeshProjectionReadiness,
    ToolingMethods,
    ToolingProjectionAuthorityRevision,
    ToolingProjectionInvalidated,
    ToolingProjectionSyncRequested,
)
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


def test_projection_topic_aliases_are_typed_tooling_constants() -> None:
    assert TOOLING_PROJECTION_INVALIDATED_TOPIC is ToolingMethods.PROJECTION_INVALIDATED
    assert TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC is ToolingMethods.PROJECTION_SYNC_REQUESTED


def _verified_manifest(*, tier: str = "projection-v1") -> SimpleNamespace:
    return SimpleNamespace(
        recipient_projection_evidence=SimpleNamespace(protocol_tier=tier),
        tooling_protocol_tiers=None,
    )


def test_protocol_negotiation_fails_closed_without_complete_projection_support() -> None:
    assert select_tooling_protocol(_verified_manifest(), manifest_status="verified").supported
    assert (
        select_tooling_protocol(_verified_manifest(), manifest_status="legacy_unverifiable").status
        == "legacy_unverifiable"
    )
    assert (
        select_tooling_protocol(
            SimpleNamespace(
                recipient_projection_evidence=None,
                tooling_protocol_tiers=["projection_v1_delta"],
            ),
            manifest_status="verified",
        ).status
        == "baseline_required"
    )
    assert (
        select_tooling_protocol(
            SimpleNamespace(recipient_projection_evidence=None),
            manifest_status="verified",
        ).status
        == "protocol_unsupported"
    )


def test_invalidation_binding_discards_every_payload_identity_claim() -> None:
    normalized = bind_invalidation_to_authenticated_provider(
        {
            "peer_id": "victim",
            "provider_id": "victim",
            "provider_peer_id": "victim",
            "service_instance_id": "remote:victim:Tooling",
            "reason_code": "auth_grant_changed",
        },
        stable_peer_id="stable-a",
    )
    assert normalized["provider_peer_id"] == "stable-a"
    assert normalized["service_instance_id"] == "remote:stable-a:Tooling"
    assert "peer_id" not in normalized
    assert "provider_id" not in normalized


@pytest.mark.asyncio
async def test_inbound_invalidation_uses_stable_authenticated_peer_not_session_or_payload() -> None:
    bus = AsyncMock()
    identity = Identity(
        principal_id="peer-a-principal",
        principal_name="peer-a",
        effective_perms=frozenset({"Tooling.use"}),
        source="webrtc_peer",
    )
    handler = RPCHandler(
        bus,
        AsyncMock(),
        MagicMock(),
        MagicMock(return_value=identity),
        mesh_config=MeshConfig(enabled=True, services={"Tooling": mesh_policy(share=True)}),
        peer_id="session-rotated-42",
        stable_peer_id_provider=lambda: "stable-a",
        authenticated_peer_validator=lambda: True,
    )

    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": TOOLING_PROJECTION_INVALIDATED_TOPIC,
                "params": {
                    "provider_peer_id": "stable-b",
                    "service_instance_id": "remote:stable-b:Tooling",
                    "reason_code": "auth_grant_changed",
                    "correlation_id": "refresh-a",
                    "authority_revision": {
                        "catalog_revision": 1,
                        "export_policy_revision": 2,
                        "auth_grant_revision": 3,
                        "manifest_revision": 4,
                        "switch_revision": 5,
                        "protocol_revision": 1,
                    },
                },
            }
        )
    )

    bus.publish.assert_awaited_once()
    topic, payload = bus.publish.await_args.args[:2]
    assert topic == TOOLING_PROJECTION_INVALIDATED_TOPIC
    assert payload["provider_peer_id"] == "stable-a"
    assert payload["service_instance_id"] == "remote:stable-a:Tooling"
    assert bus.publish.await_args.kwargs["caller_peer_id"] == "stable-a"


@pytest.mark.asyncio
async def test_inbound_rpc_invalidation_reaches_local_tooling_sync_request() -> None:
    gateway = GatewayService()
    gateway._rtc_client = MagicMock()
    gateway._rtc_client._has_authenticated_stable_peer.return_value = True
    observed_syncs: list[ToolingProjectionSyncRequested] = []

    class InlineBus:
        async def publish(self, topic, payload, **kwargs):
            if topic == TOOLING_PROJECTION_INVALIDATED_TOPIC:
                await gateway._handle_tooling_projection_invalidated(
                    Envelope(
                        type=topic,
                        payload=payload,
                        origin=kwargs.get("origin", "internal"),
                        caller_peer_id=kwargs.get("caller_peer_id"),
                        principal_id=kwargs.get("principal_id"),
                        identity_source=kwargs.get("identity_source"),
                    )
                )
            elif topic == TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC:
                observed_syncs.append(ToolingProjectionSyncRequested.model_validate(payload))

    bus = InlineBus()
    identity = Identity(
        principal_id="stable-a-principal",
        principal_name="stable-a",
        effective_perms=frozenset({"Tooling.use"}),
        source="webrtc_peer",
    )
    handler = RPCHandler(
        bus,
        AsyncMock(),
        MagicMock(),
        MagicMock(return_value=identity),
        mesh_config=MeshConfig(enabled=True, services={"Tooling": mesh_policy(share=True)}),
        peer_id="session-rotated",
        stable_peer_id_provider=lambda: "stable-a",
        authenticated_peer_validator=lambda: True,
    )
    invalidation = ToolingProjectionInvalidated(
        provider_peer_id="payload-spoof",
        service_instance_id="remote:payload-spoof:Tooling",
        authority_revision=ToolingProjectionAuthorityRevision(
            catalog_revision=1,
            export_policy_revision=2,
            auth_grant_revision=3,
            manifest_revision=4,
            switch_revision=5,
        ),
        reason_code="policy_changed",
        correlation_id="rpc-to-sync",
    )

    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        await handler.on_message(
            json.dumps(
                {
                    "type": "event",
                    "topic": TOOLING_PROJECTION_INVALIDATED_TOPIC,
                    "params": invalidation.model_dump(mode="json"),
                }
            )
        )

    assert len(observed_syncs) == 1
    assert observed_syncs[0].provider_peer_id == "stable-a"
    assert observed_syncs[0].service_instance_id == "remote:stable-a:Tooling"
    assert observed_syncs[0].force_full_snapshot is True


@pytest.mark.asyncio
async def test_invalidation_without_stable_authenticated_identity_is_dropped() -> None:
    bus = AsyncMock()
    identity = Identity(
        principal_id="peer-principal",
        principal_name="peer",
        effective_perms=frozenset({"Tooling.use"}),
        source="webrtc_peer",
    )
    handler = RPCHandler(
        bus,
        AsyncMock(),
        MagicMock(),
        MagicMock(return_value=identity),
        mesh_config=MeshConfig(enabled=True, services={"Tooling": mesh_policy(share=True)}),
        peer_id="session-only",
    )
    await handler.on_message(
        json.dumps(
            {
                "type": "event",
                "topic": TOOLING_PROJECTION_INVALIDATED_TOPIC,
                "params": {"provider_peer_id": "claimed"},
            }
        )
    )
    bus.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_sync_request_is_local_targeted_and_never_mesh_broadcast() -> None:
    client = RTCClient.__new__(RTCClient)
    client._bus = AsyncMock()
    client._mesh_config = MeshConfig(
        enabled=True,
        services={"Tooling": mesh_policy(share=True)},
    )
    client._mesh_policy_provider = None

    await client._request_tooling_projection_sync(
        "stable-a",
        reason="manifest_revision_changed",
    )

    client._bus.publish.assert_awaited_once()
    topic, payload = client._bus.publish.await_args.args[:2]
    assert topic == TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC
    assert isinstance(payload, ToolingProjectionSyncRequested)
    assert payload.provider_peer_id == "stable-a"
    assert payload.force_full_snapshot is True
    assert client._bus.publish.await_args.kwargs["mesh"] is False


def test_targeted_invalidation_sends_only_to_addressed_stable_peer() -> None:
    client = RTCClient.__new__(RTCClient)
    client._peer_bridge = MagicMock()
    client._stable_peer_sessions = {"stable-a": "session-a"}
    client._has_authenticated_stable_peer = MagicMock(side_effect=lambda peer: peer == "stable-a")
    client._provider_tooling_authority_revisions = MagicMock(return_value=(11, 13))
    invalidation = ToolingProjectionInvalidated(
        provider_peer_id="stable-local",
        service_instance_id="local:Tooling",
        authority_revision=ToolingProjectionAuthorityRevision(
            catalog_revision=1,
            export_policy_revision=2,
            auth_grant_revision=0,
            manifest_revision=0,
            switch_revision=3,
        ),
        reason_code="catalog_changed",
        correlation_id="only-a",
    )

    assert client.send_tooling_projection_invalidation("stable-a", invalidation) is True
    assert client.send_tooling_projection_invalidation("stable-b", invalidation) is False
    call = client._peer_bridge.fire_event.call_args
    assert call.args[:2] == ("stable-a", TOOLING_PROJECTION_INVALIDATED_TOPIC)
    sent = call.args[2]
    assert sent.authority_revision.auth_grant_revision == 11
    assert sent.authority_revision.manifest_revision == 13
    assert call.kwargs == {"correlation_id": "only-a"}


def test_failed_invalidation_is_retained_until_confirmed_retry() -> None:
    client = RTCClient.__new__(RTCClient)
    client._peer_bridge = MagicMock()
    client._peer_bridge.fire_event.side_effect = [False, True]
    client._stable_peer_sessions = {"stable-a": "session-a"}
    client._has_authenticated_stable_peer = MagicMock(return_value=True)
    client._provider_tooling_authority_revisions = MagicMock(return_value=(11, 13))
    client._latest_tooling_projection_invalidation = None
    client._latest_tooling_projection_invalidations_by_peer = OrderedDict()
    invalidation = ToolingProjectionInvalidated(
        provider_peer_id="stable-local",
        service_instance_id="local:Tooling",
        authority_revision=ToolingProjectionAuthorityRevision(
            catalog_revision=1,
            export_policy_revision=2,
            auth_grant_revision=0,
            manifest_revision=0,
            switch_revision=3,
        ),
        reason_code="catalog_changed",
        correlation_id="retry-a",
        affected_peer_ids=["stable-a"],
    )

    client.remember_tooling_projection_invalidation(invalidation)
    assert client.send_tooling_projection_invalidation("stable-a", invalidation) is False
    assert client._latest_tooling_projection_invalidations_by_peer["stable-a"] == invalidation

    assert client.retry_tooling_projection_invalidation("stable-a") is True
    assert "stable-a" not in client._latest_tooling_projection_invalidations_by_peer
    assert client._peer_bridge.fire_event.call_count == 2


@pytest.mark.asyncio
async def test_invalidation_retry_is_coalesced_and_bounded(monkeypatch) -> None:
    client = RTCClient.__new__(RTCClient)
    client._tooling_invalidation_retry_tasks = {}
    client.retry_tooling_projection_invalidation = MagicMock(return_value=False)
    sleep = AsyncMock()
    monkeypatch.setattr("app.services.gateway.webrtc.rtc_client.asyncio.sleep", sleep)

    client.schedule_tooling_projection_invalidation_retry("stable-a")
    task = client._tooling_invalidation_retry_tasks["stable-a"]
    client.schedule_tooling_projection_invalidation_retry("stable-a")
    assert client._tooling_invalidation_retry_tasks["stable-a"] is task

    await task

    assert client.retry_tooling_projection_invalidation.call_count == 3
    assert sleep.await_args_list == [((0.1,),), ((0.5,),), ((2.0,),)]
    assert client._tooling_invalidation_retry_tasks == {}


@pytest.mark.asyncio
async def test_local_projection_invalidation_fans_out_only_to_rtc_eligible_recipients() -> None:
    gateway = GatewayService()
    gateway._mesh_peer_id = "stable-local"
    gateway._rtc_client = MagicMock()
    gateway._rtc_client.tooling_projection_invalidation_recipients.return_value = [
        "stable-a",
        "stable-c",
    ]
    invalidation = ToolingProjectionInvalidated(
        provider_peer_id="stable-local",
        service_instance_id="local:Tooling",
        authority_revision=ToolingProjectionAuthorityRevision(
            catalog_revision=1,
            export_policy_revision=2,
            auth_grant_revision=0,
            manifest_revision=0,
            switch_revision=3,
        ),
        reason_code="catalog_changed",
        correlation_id="fanout",
    )

    await gateway._handle_tooling_projection_invalidated(
        Envelope(
            type=TOOLING_PROJECTION_INVALIDATED_TOPIC,
            payload=invalidation,
            origin="internal",
        )
    )

    assert gateway._rtc_client.send_tooling_projection_invalidation.call_args_list == [
        (("stable-a", invalidation),),
        (("stable-c", invalidation),),
    ]
    gateway._rtc_client.remember_tooling_projection_invalidation.assert_called_once_with(
        invalidation
    )


@pytest.mark.asyncio
async def test_local_projection_invalidation_schedules_retry_after_failed_send() -> None:
    gateway = GatewayService()
    gateway._mesh_peer_id = "stable-local"
    gateway._rtc_client = MagicMock()
    gateway._rtc_client.tooling_projection_invalidation_recipients.return_value = ["stable-a"]
    gateway._rtc_client.send_tooling_projection_invalidation.return_value = False
    invalidation = ToolingProjectionInvalidated(
        provider_peer_id="stable-local",
        service_instance_id="local:Tooling",
        authority_revision=ToolingProjectionAuthorityRevision(
            catalog_revision=1,
            export_policy_revision=2,
            auth_grant_revision=0,
            manifest_revision=0,
            switch_revision=3,
        ),
        reason_code="catalog_changed",
        correlation_id="retry-failed",
    )

    await gateway._handle_tooling_projection_invalidated(
        Envelope(
            type=TOOLING_PROJECTION_INVALIDATED_TOPIC,
            payload=invalidation,
            origin="internal",
        )
    )

    gateway._rtc_client.remember_tooling_projection_invalidation.assert_called_once_with(
        invalidation
    )
    gateway._rtc_client.schedule_tooling_projection_invalidation_retry.assert_called_once_with(
        "stable-a"
    )


@pytest.mark.asyncio
async def test_local_projection_invalidation_intersects_affected_peers_with_rtc_eligibility() -> (
    None
):
    gateway = GatewayService()
    gateway._mesh_peer_id = "stable-local"
    gateway._rtc_client = MagicMock()
    gateway._rtc_client.tooling_projection_invalidation_recipients.return_value = [
        "stable-a",
        "stable-b",
        "stable-c",
    ]
    invalidation = ToolingProjectionInvalidated(
        provider_peer_id="stable-local",
        service_instance_id="local:Tooling",
        authority_revision=ToolingProjectionAuthorityRevision(
            catalog_revision=1,
            export_policy_revision=2,
            auth_grant_revision=0,
            manifest_revision=0,
            switch_revision=3,
        ),
        reason_code="peer_override_changed",
        correlation_id="affected-only",
        affected_peer_ids=["stable-b", "not-authenticated"],
    )

    await gateway._handle_tooling_projection_invalidated(
        Envelope(
            type=TOOLING_PROJECTION_INVALIDATED_TOPIC,
            payload=invalidation,
            origin="internal",
        )
    )

    gateway._rtc_client.send_tooling_projection_invalidation.assert_called_once_with(
        "stable-b", invalidation
    )


@pytest.mark.asyncio
async def test_gateway_page_proxy_addresses_stable_peer_and_stamps_authority_revisions() -> None:
    gateway = GatewayService()
    gateway._mesh_peer_id = "stable-local"
    gateway._rtc_client = MagicMock()
    gateway._rtc_client.remote_tooling_authority_revisions.return_value = (17, 23)
    gateway._mesh_peer_bridge = MagicMock()
    page = ToolingGetExportCatalogResponse(
        provider_peer_id="stable-provider",
        service_instance_id="remote:stable-provider:Tooling",
        authority_revision=ToolingProjectionAuthorityRevision(
            catalog_revision=1,
            export_policy_revision=2,
            auth_grant_revision=17,
            manifest_revision=23,
            switch_revision=1,
        ),
        projection_revision="projection-1",
        projection_digest="1" * 64,
        page_index=0,
        page_size=100,
        page_hash="2" * 64,
        complete=True,
        total_count=0,
        final_checksum="3" * 64,
    )
    gateway._mesh_peer_bridge.call = AsyncMock(
        return_value=QueryResult(ok=True, data=page.model_dump(mode="json"))
    )
    request = GatewayFetchToolingExportCatalogPageRequest(
        provider_peer_id="stable-provider",
        request=ToolingGetExportCatalogRequest(page_size=100),
    )

    response = await gateway._fetch_tooling_export_catalog_page(request)

    assert response.ok is True
    assert response.page == page
    call = gateway._mesh_peer_bridge.call.await_args
    assert call.args[:2] == ("stable-provider", ToolingMethods.GET_EXPORT_CATALOG)
    assert call.kwargs["caller_peer_id"] == "stable-local"
    assert call.kwargs["auth_grant_revision"] == 17
    assert call.kwargs["manifest_revision"] == 23
    assert "provider_peer_id" not in call.args[2].model_dump()


@pytest.mark.asyncio
async def test_gateway_page_proxy_rejects_session_or_payload_route_without_stable_authority() -> (
    None
):
    gateway = GatewayService()
    gateway._mesh_peer_id = "stable-local"
    gateway._rtc_client = MagicMock()
    gateway._rtc_client.remote_tooling_authority_revisions.return_value = None
    gateway._mesh_peer_bridge = MagicMock()
    gateway._mesh_peer_bridge.call = AsyncMock()

    response = await gateway._fetch_tooling_export_catalog_page(
        GatewayFetchToolingExportCatalogPageRequest(
            provider_peer_id="session-id-masquerading-as-peer",
            request=ToolingGetExportCatalogRequest(),
        )
    )

    assert response.ok is False
    assert response.reason_code == "authenticated_provider_unavailable"
    gateway._mesh_peer_bridge.call.assert_not_awaited()


@pytest.mark.asyncio
async def test_activation_coordinator_fails_closed_then_is_idempotent_after_concrete_reports() -> (
    None
):
    gateway = GatewayService()
    gateway._tooling_invalidation_subscription_ready = True
    bus = AsyncMock()
    unavailable = QueryResult(ok=False, error="tooling_not_ready")
    bus.request.return_value = unavailable

    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        assert await gateway._coordinate_tooling_mesh_activation() is False
    bus.publish.assert_not_awaited()

    readiness = ToolingMeshProjectionReadiness(
        projection_transport=True,
        normalized_catalog=True,
        consumer_binding=True,
        provider_discovery=True,
        prepare_enforcement=True,
        execute_enforcement=True,
        typed_exposure_ledger=True,
        execution_rpc_evidence=True,
        exact_method_set=True,
        mutation_invalidation=True,
        conditional_legacy_retirement=True,
        legacy_guard_active=True,
        durable_active=False,
        durable_revision=0,
    )
    activated = QueryResult(
        ok=True,
        data={
            "state": {
                "active": True,
                "legacy_guard_retired": True,
                "revision": 1,
            }
        },
    )
    bus.request.side_effect = [
        QueryResult(ok=True, data=readiness.model_dump(mode="python")),
        activated,
        QueryResult(
            ok=True,
            data=readiness.model_copy(
                update={
                    "legacy_guard_active": False,
                    "durable_active": True,
                    "durable_revision": 1,
                }
            ).model_dump(mode="python"),
        ),
        activated,
    ]

    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        assert await gateway._coordinate_tooling_mesh_activation() is True
        assert await gateway._coordinate_tooling_mesh_activation() is True
    assert bus.publish.await_count == 2
