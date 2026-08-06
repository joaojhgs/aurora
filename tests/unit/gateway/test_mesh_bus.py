"""Unit tests for MeshBus routing decisions and fallback behavior."""

from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, MagicMock

import pytest
from pydantic import BaseModel

from app.messaging.bus import QueryResult
from app.messaging.mesh_bus import MeshBus
from app.services.gateway.config import MeshConfig
from app.services.gateway.mesh.models import RouteDecision
from app.services.gateway.mesh.policy_store import MeshPolicySnapshot, MeshPolicyStore
from app.shared.contracts.models.mesh import MeshAddressSelector
from tests.unit.gateway.mesh_policy_helpers import mesh_policy


class FakePayload(BaseModel):
    text: str = "hello"
    dispatch_selector: MeshAddressSelector | None = None
    mesh_selector: MeshAddressSelector | None = None
    selector: MeshAddressSelector | None = None
    inference_selector: MeshAddressSelector | None = None


class _FakeLeaseRegistry:
    def __init__(self, peers: list[str], *, capacity_denied: set[str] | None = None):
        self.peers = peers
        self.capacity_denied = capacity_denied or set()
        self.acquired: list[tuple[str, str]] = []
        self.released: list[object] = []
        self.candidate_calls: list[dict[str, object]] = []

    def get_provider_candidates(self, **kwargs):
        self.candidate_calls.append(kwargs)
        excluded = set(kwargs.get("exclude") or [])
        module = str(kwargs["module"])
        return [
            SimpleNamespace(
                peer=SimpleNamespace(peer_id=peer_id, latency_ms=1.0),
                service=SimpleNamespace(module=module, version="1.0.0"),
                eligible=True,
            )
            for peer_id in self.peers
            if peer_id not in excluded
        ]

    async def acquire_capacity_lease(self, peer_id: str, module: str):
        if peer_id in self.capacity_denied:
            return None
        lease = SimpleNamespace(peer_id=peer_id, module=module, lease_id=f"{peer_id}:{module}")
        self.acquired.append((peer_id, module))
        return lease

    async def release_capacity_lease(self, lease):
        self.released.append(lease)


@pytest.fixture
def inner_bus():
    bus = AsyncMock()
    bus.publish = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"result": "local"}))
    bus.subscribe = MagicMock()
    return bus


@pytest.fixture
def routing_table():
    rt = MagicMock()
    rt.resolve = MagicMock(return_value=RouteDecision(target="local", module="TTS"))
    rt.resolve_fallback = MagicMock(return_value=RouteDecision(target="local", module="TTS"))
    return rt


@pytest.fixture
def peer_bridge():
    pb = MagicMock()
    pb.call = AsyncMock(return_value=QueryResult(ok=True, data={"result": "remote"}))
    pb.fire_event = MagicMock()
    return pb


@pytest.fixture
def mesh_config():
    return MeshConfig(
        enabled=True,
        node_name="test",
        services={
            "TTS": mesh_policy(prefer="network", fallback="local"),
        },
    )


@pytest.fixture
def mesh_bus(inner_bus, routing_table, peer_bridge, mesh_config):
    return MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)


class TestMeshBusPublish:
    """Tests for MeshBus.publish()."""

    @pytest.mark.asyncio
    async def test_events_go_local_by_default(self, mesh_bus, inner_bus, routing_table):
        """Events without mesh=True are delivered locally only."""
        await mesh_bus.publish("TTS.StateChanged", FakePayload(), event=True)
        inner_bus.publish.assert_awaited_once()
        routing_table.resolve.assert_not_called()

    @pytest.mark.asyncio
    async def test_events_with_mesh_false_not_forwarded(
        self, inner_bus, routing_table, peer_bridge
    ):
        """Events with explicit mesh=False are NOT forwarded to peers."""
        cfg = MeshConfig(
            enabled=True,
            node_name="test",
            services={"TTS": mesh_policy(share=True, prefer="network", fallback="local")},
        )
        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)

        await bus.publish("TTS.StateChanged", FakePayload(), event=True, mesh=False)
        inner_bus.publish.assert_awaited_once()
        peer_bridge.fire_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_events_with_mesh_true_forwarded_when_shared(
        self, inner_bus, routing_table, peer_bridge
    ):
        """Events with mesh=True are forwarded to peers when the module is shared."""
        cfg = MeshConfig(
            enabled=True,
            node_name="test",
            services={"TTS": mesh_policy(share=True, prefer="network", fallback="local")},
        )
        fake_peer = MagicMock()
        fake_peer.peer_id = "peer-1"
        routing_table.get_negotiated_peers.return_value = [fake_peer]

        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)
        await bus.publish("TTS.Started", FakePayload(), event=True, mesh=True)

        # Local delivery
        inner_bus.publish.assert_awaited_once()
        # Peer forwarding
        peer_bridge.fire_event.assert_called_once_with(
            "peer-1",
            "TTS.Started",
            FakePayload(),
            correlation_id=None,
        )

    @pytest.mark.asyncio
    async def test_events_with_mesh_true_not_forwarded_when_not_shared(
        self, inner_bus, routing_table, peer_bridge
    ):
        """Events with mesh=True are NOT forwarded when the module share=false."""
        cfg = MeshConfig(
            enabled=True,
            node_name="test",
            services={"TTS": mesh_policy(share=False, prefer="network", fallback="local")},
        )
        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)

        await bus.publish("TTS.Started", FakePayload(), event=True, mesh=True)
        inner_bus.publish.assert_awaited_once()
        peer_bridge.fire_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_events_with_mesh_true_not_forwarded_when_mesh_disabled(
        self, inner_bus, routing_table, peer_bridge
    ):
        cfg = MeshConfig(
            enabled=False,
            node_name="test",
            services={"TTS": mesh_policy(share=True, prefer="network", fallback="local")},
        )
        fake_peer = MagicMock()
        fake_peer.peer_id = "peer-1"
        routing_table.get_negotiated_peers.return_value = [fake_peer]
        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)

        await bus.publish("TTS.Started", FakePayload(), event=True, mesh=True)

        inner_bus.publish.assert_awaited_once()
        routing_table.get_negotiated_peers.assert_not_called()
        peer_bridge.fire_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_mesh_forwarded_events_not_re_forwarded(
        self, inner_bus, routing_table, peer_bridge
    ):
        """Events from mesh peers (origin=mesh_forwarded) are NOT re-forwarded."""
        cfg = MeshConfig(
            enabled=True,
            node_name="test",
            services={"TTS": mesh_policy(share=True, prefer="network", fallback="local")},
        )
        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)

        await bus.publish(
            "TTS.Started", FakePayload(), event=True, mesh=True, origin="mesh_forwarded"
        )
        inner_bus.publish.assert_awaited_once()
        peer_bridge.fire_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_events_with_mesh_true_no_sharing_config(self, mesh_bus, inner_bus, peer_bridge):
        """Events with mesh=True but no sharing config for module stay local."""
        # Default mesh_config fixture has no sharing entries
        await mesh_bus.publish("Unknown.Event", FakePayload(), event=True, mesh=True)
        inner_bus.publish.assert_awaited_once()
        peer_bridge.fire_event.assert_not_called()

    @pytest.mark.asyncio
    async def test_events_forwarded_to_multiple_peers(self, inner_bus, routing_table, peer_bridge):
        """Events with mesh=True are forwarded to ALL negotiated peers."""
        cfg = MeshConfig(
            enabled=True,
            node_name="test",
            services={"TTS": mesh_policy(share=True)},
        )
        peer1 = MagicMock()
        peer1.peer_id = "peer-1"
        peer2 = MagicMock()
        peer2.peer_id = "peer-2"
        routing_table.get_negotiated_peers.return_value = [peer1, peer2]

        bus = MeshBus(inner_bus, routing_table, peer_bridge, cfg)
        await bus.publish("TTS.Started", FakePayload(), event=True, mesh=True)

        assert peer_bridge.fire_event.call_count == 2

    @pytest.mark.asyncio
    async def test_command_local_route(self, mesh_bus, inner_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="local", module="TTS")
        await mesh_bus.publish("TTS.Request", FakePayload(), event=False)
        inner_bus.publish.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_local_command_preserves_auth_metadata_on_inner_publish(
        self, mesh_bus, inner_bus, routing_table
    ):
        """Local MeshBus command routes must preserve Gateway/Mesh auth metadata."""

        routing_table.resolve.return_value = RouteDecision(target="local", module="TTS")

        await mesh_bus.publish(
            "TTS.Request",
            FakePayload(),
            event=False,
            origin="external",
            principal_id="principal-1",
            effective_perms=["TTS.Request"],
            identity_source="mesh_peer",
            method_type="use",
            caller_peer_id="peer-1",
            correlation_id="corr-local-auth",
        )

        inner_bus.publish.assert_awaited_once()
        _, kwargs = inner_bus.publish.await_args
        assert kwargs["principal_id"] == "principal-1"
        assert kwargs["effective_perms"] == ["TTS.Request"]
        assert kwargs["identity_source"] == "mesh_peer"
        assert kwargs["method_type"] == "use"
        assert kwargs["caller_peer_id"] == "peer-1"
        assert kwargs["correlation_id"] == "corr-local-auth"

    @pytest.mark.asyncio
    async def test_command_passes_selector_to_routing(self, mesh_bus, routing_table):
        selector = MeshAddressSelector(peer_id="peer-1")
        await mesh_bus.publish("TTS.Request", FakePayload(mesh_selector=selector), event=False)
        routing_table.resolve.assert_called_once_with(
            "TTS.Request",
            routing_config=ANY,
            mesh_config=ANY,
            selector=selector,
            policy_snapshot=ANY,
        )

    @pytest.mark.asyncio
    async def test_command_remote_route(self, mesh_bus, inner_bus, routing_table, peer_bridge):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        await mesh_bus.publish("TTS.Request", FakePayload(), event=False)
        peer_bridge.call.assert_awaited_once()
        inner_bus.publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_command_uses_one_live_snapshot_for_timeout_and_routing(
        self, inner_bus, routing_table, peer_bridge
    ):
        store = MeshPolicyStore()
        first = store.replace(
            MeshConfig(
                enabled=True,
                remote_timeout_s=3.0,
                services={"TTS": mesh_policy(prefer="network")},
            ),
            source_revision=1,
        )
        store.replace(
            first.mesh_config.model_copy(update={"remote_timeout_s": 7.5}),
            source_revision=2,
        )
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        bus = MeshBus(
            inner_bus,
            routing_table,
            peer_bridge,
            first.mesh_config,
            policy_provider=store.provider(),
        )

        await bus.publish("TTS.Request", FakePayload(), event=False)

        routing_table.resolve.assert_called_once()
        policy_snapshot = routing_table.resolve.call_args.kwargs["policy_snapshot"]
        assert policy_snapshot is store.current()
        assert policy_snapshot.revision == store.current().revision
        assert routing_table.resolve.call_args.kwargs["mesh_config"] is policy_snapshot.mesh_config
        assert policy_snapshot.mesh_config.remote_timeout_s == 7.5
        peer_bridge.call.assert_awaited_once()
        assert peer_bridge.call.await_args.kwargs["timeout"] == 7.5

    @pytest.mark.asyncio
    async def test_command_remote_fallback_uses_one_policy_snapshot(
        self, inner_bus, routing_table, peer_bridge
    ):
        store = MeshPolicyStore()
        snapshot = store.replace(
            MeshConfig(
                enabled=True,
                remote_timeout_s=4.0,
                services={"TTS": mesh_policy(prefer="network", fallback="local")},
            ),
            source_revision=1,
        )
        calls = 0

        def provider():
            nonlocal calls
            calls += 1
            return store.current()

        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        routing_table.resolve_fallback.return_value = RouteDecision(target="local", module="TTS")
        peer_bridge.call.side_effect = Exception("offline")
        bus = MeshBus(
            inner_bus,
            routing_table,
            peer_bridge,
            snapshot.mesh_config,
            policy_provider=provider,
        )

        await bus.publish("TTS.Request", FakePayload(), event=False)

        assert calls == 1
        routing_table.resolve.assert_called_once()
        routing_table.resolve_fallback.assert_called_once()
        assert routing_table.resolve.call_args.kwargs["policy_snapshot"] is snapshot
        assert (
            routing_table.resolve.call_args.kwargs["policy_snapshot"].revision == snapshot.revision
        )
        assert routing_table.resolve_fallback.call_args.kwargs["policy_snapshot"] is snapshot
        assert routing_table.resolve.call_args.kwargs["mesh_config"] is snapshot.mesh_config
        assert (
            routing_table.resolve_fallback.call_args.kwargs["mesh_config"] is snapshot.mesh_config
        )
        inner_bus.publish.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_command_without_policy_provider_uses_real_zero_revision_snapshot(
        self, inner_bus, routing_table, peer_bridge, mesh_config
    ):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        bus = MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)

        await bus.publish("TTS.Request", FakePayload(), event=False)

        snapshot = routing_table.resolve.call_args.kwargs["policy_snapshot"]
        assert isinstance(snapshot, MeshPolicySnapshot)
        assert snapshot.revision == 0
        assert snapshot.source_revision is None
        assert snapshot.mesh_config is mesh_config

    @pytest.mark.asyncio
    async def test_command_remote_failure_falls_back_local(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        peer_bridge.call.side_effect = Exception("connection lost")
        routing_table.resolve_fallback.return_value = RouteDecision(target="local", module="TTS")
        await mesh_bus.publish("TTS.Request", FakePayload(), event=False)
        inner_bus.publish.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_command_error_route_raises(self, mesh_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="error", module="TTS")
        with pytest.raises(RuntimeError, match="No remote peer"):
            await mesh_bus.publish("TTS.Request", FakePayload(), event=False)

    @pytest.mark.asyncio
    async def test_command_none_route_drops(self, mesh_bus, inner_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="none", module="TTS")
        await mesh_bus.publish("TTS.Request", FakePayload(), event=False)
        inner_bus.publish.assert_not_awaited()


class TestMeshBusRequest:
    """Tests for MeshBus.request()."""

    @pytest.mark.asyncio
    async def test_local_request(self, mesh_bus, inner_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="local", module="TTS")
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is True
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_request(self, mesh_bus, routing_table, peer_bridge):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is True
        peer_bridge.call.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_request_failure_falls_back_local(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        peer_bridge.call.side_effect = Exception("timeout")
        routing_table.resolve_fallback.return_value = RouteDecision(target="local", module="TTS")
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is True
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_explicit_remote_request_failure_does_not_fallback_local(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        selector = MeshAddressSelector(peer_id="peer-1")
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS", selector=selector
        )
        peer_bridge.call.side_effect = Exception("timeout")
        routing_table.resolve_fallback.return_value = RouteDecision(
            target="error",
            module="TTS",
            selector=selector,
            error_code="selector_target_failed",
            error_message="TTS explicit selector target failed; transparent fallback skipped",
        )

        result = await mesh_bus.request("TTS.Request", FakePayload(mesh_selector=selector))

        assert result.ok is False
        assert "transparent fallback skipped" in result.error
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_dispatch_selector_precedes_legacy_and_inference_is_ignored(
        self, mesh_bus, routing_table
    ):
        dispatch = MeshAddressSelector(peer_id="dispatch-peer")
        legacy = MeshAddressSelector(peer_id="legacy-peer")
        inference = MeshAddressSelector(peer_id="inference-peer")

        await mesh_bus.request(
            "TTS.Request",
            FakePayload(
                dispatch_selector=dispatch,
                mesh_selector=legacy,
                inference_selector=inference,
            ),
        )

        routing_table.resolve.assert_called_once_with(
            "TTS.Request",
            routing_config=ANY,
            mesh_config=ANY,
            selector=dispatch,
            policy_snapshot=ANY,
        )

    @pytest.mark.asyncio
    async def test_inference_selector_alone_does_not_affect_dispatch_routing(
        self, mesh_bus, routing_table
    ):
        inference = MeshAddressSelector(peer_id="inference-peer")

        await mesh_bus.request("TTS.Request", FakePayload(inference_selector=inference))

        routing_table.resolve.assert_called_once_with(
            "TTS.Request",
            routing_config=ANY,
            mesh_config=ANY,
            selector=None,
            policy_snapshot=ANY,
        )

    @pytest.mark.asyncio
    async def test_model_catalog_mesh_selector_is_business_input_not_dispatch_selector(
        self, mesh_bus, routing_table
    ):
        from app.shared.contracts.models.orchestrator import OrchestratorMethods

        payload = {"include_remote": True, "mesh_selector": {"peer_id": "catalog-peer"}}

        await mesh_bus.request(OrchestratorMethods.GET_MODEL_CATALOG, payload)

        routing_table.resolve.assert_called_once_with(
            OrchestratorMethods.GET_MODEL_CATALOG,
            routing_config=ANY,
            mesh_config=ANY,
            selector=None,
            policy_snapshot=ANY,
        )

    @pytest.mark.asyncio
    async def test_route_explain_selector_is_business_input_not_dispatch_selector(
        self, mesh_bus, routing_table
    ):
        from app.shared.contracts.models.gateway import GatewayMethods

        payload = {
            "topic": "Scheduler.ScheduleJob",
            "selector": {"peer_id": "studio-peer"},
        }

        await mesh_bus.request(GatewayMethods.EXPLAIN_ROUTE, payload)

        routing_table.resolve.assert_called_once_with(
            GatewayMethods.EXPLAIN_ROUTE,
            routing_config=ANY,
            mesh_config=ANY,
            selector=None,
            policy_snapshot=ANY,
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("selector_key", ["dispatch_selector", "mesh_selector"])
    async def test_route_explain_explicit_dispatch_selectors_still_route(
        self, mesh_bus, routing_table, selector_key
    ):
        from app.shared.contracts.models.gateway import GatewayMethods

        expected_selector = MeshAddressSelector(peer_id="gateway-peer")
        payload = {
            "topic": "Scheduler.ScheduleJob",
            "selector": {"peer_id": "studio-peer"},
            selector_key: {"peer_id": "gateway-peer"},
        }

        await mesh_bus.request(GatewayMethods.EXPLAIN_ROUTE, payload)

        routing_table.resolve.assert_called_once_with(
            GatewayMethods.EXPLAIN_ROUTE,
            routing_config=ANY,
            mesh_config=ANY,
            selector=expected_selector,
            policy_snapshot=ANY,
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("selector_key", ["mesh_selector", "selector"])
    async def test_dict_payload_selector_routes_selected_peer(
        self, mesh_bus, inner_bus, routing_table, peer_bridge, selector_key
    ):
        from app.shared.contracts.models.orchestrator import OrchestratorMethods

        expected_selector = MeshAddressSelector(peer_id="assistant-peer")

        def resolve_by_selector(
            topic,
            *,
            routing_config=None,
            mesh_config=None,
            selector=None,
            policy_snapshot=None,
        ):
            assert topic == OrchestratorMethods.EXTERNAL_USER_INPUT
            if selector == expected_selector:
                return RouteDecision(
                    target="remote",
                    peer_id="assistant-peer",
                    module="Orchestrator",
                    selector=selector,
                )
            return RouteDecision(target="local", module="Orchestrator", selector=selector)

        routing_table.resolve.side_effect = resolve_by_selector
        payload = {"text": "hello", selector_key: {"peer_id": "assistant-peer"}}

        result = await mesh_bus.request(OrchestratorMethods.EXTERNAL_USER_INPUT, payload)

        assert result.ok is True
        routing_table.resolve.assert_called_once_with(
            OrchestratorMethods.EXTERNAL_USER_INPUT,
            routing_config=ANY,
            mesh_config=ANY,
            selector=expected_selector,
            policy_snapshot=ANY,
        )
        peer_bridge.call.assert_awaited_once_with(
            "assistant-peer",
            OrchestratorMethods.EXTERNAL_USER_INPUT,
            payload,
            timeout=5.0,
            correlation_id=peer_bridge.call.await_args.kwargs["correlation_id"],
            principal_id=None,
            effective_perms=None,
            identity_source=None,
            method_type=None,
            caller_peer_id=None,
            auth_grant_revision=None,
            manifest_revision=None,
        )
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_orchestrator_external_user_input_mesh_selector_routes_selected_peer(
        self, mesh_bus, routing_table, peer_bridge
    ):
        from app.shared.contracts.models.orchestrator import (
            OrchestratorMethods,
            OrchestratorProcessRequest,
        )

        selector = MeshAddressSelector(peer_id="assistant-peer")
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="assistant-peer", module="Orchestrator", selector=selector
        )

        result = await mesh_bus.request(
            OrchestratorMethods.EXTERNAL_USER_INPUT,
            OrchestratorProcessRequest(text="hello", mesh_selector=selector),
        )

        assert result.ok is True
        routing_table.resolve.assert_called_once_with(
            OrchestratorMethods.EXTERNAL_USER_INPUT,
            routing_config=ANY,
            mesh_config=ANY,
            selector=selector,
            policy_snapshot=ANY,
        )
        peer_bridge.call.assert_awaited_once()
        assert peer_bridge.call.await_args.args[:3] == (
            "assistant-peer",
            OrchestratorMethods.EXTERNAL_USER_INPUT,
            OrchestratorProcessRequest(text="hello", mesh_selector=selector),
        )

    @pytest.mark.asyncio
    async def test_orchestrator_external_user_input_explicit_selector_failure_does_not_fallback(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        from app.shared.contracts.models.orchestrator import (
            OrchestratorMethods,
            OrchestratorProcessRequest,
        )

        selector = MeshAddressSelector(peer_id="assistant-peer")
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="assistant-peer", module="Orchestrator", selector=selector
        )
        peer_bridge.call.side_effect = Exception("offline")
        routing_table.resolve_fallback.return_value = RouteDecision(
            target="error",
            module="Orchestrator",
            selector=selector,
            error_code="selector_target_failed",
            error_message="Orchestrator explicit selector target failed; transparent fallback skipped",
        )

        result = await mesh_bus.request(
            OrchestratorMethods.EXTERNAL_USER_INPUT,
            OrchestratorProcessRequest(text="hello", mesh_selector=selector),
        )

        assert result.ok is False
        assert "transparent fallback skipped" in result.error
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_remote_error_result_triggers_fallback(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-1", module="TTS"
        )
        peer_bridge.call.return_value = QueryResult(ok=False, error="Service error")
        routing_table.resolve_fallback.return_value = RouteDecision(target="local", module="TTS")
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is True
        inner_bus.request.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_remote_request_fallbacks_across_all_unattempted_provider_failures(
        self, inner_bus, routing_table, peer_bridge, mesh_config
    ):
        store = MeshPolicyStore()
        snapshot = store.replace(mesh_config, source_revision=123)
        registry = _FakeLeaseRegistry(["peer-a", "peer-b", "peer-c"])
        routing_table._registry = registry
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-a", module="TTS"
        )
        peer_bridge.call.side_effect = [
            RuntimeError("transport down"),
            QueryResult(ok=False, error="application failed"),
            QueryResult(ok=True, data={"result": "peer-c"}),
        ]
        bus = MeshBus(
            inner_bus,
            routing_table,
            peer_bridge,
            mesh_config,
            policy_provider=store.provider(),
        )

        result = await bus.request("TTS.Request", FakePayload())

        assert result == QueryResult(ok=True, data={"result": "peer-c"})
        assert [call.args[0] for call in peer_bridge.call.await_args_list] == [
            "peer-a",
            "peer-b",
            "peer-c",
        ]
        assert registry.acquired == [("peer-a", "TTS"), ("peer-b", "TTS"), ("peer-c", "TTS")]
        assert [(lease.peer_id, lease.module) for lease in registry.released] == [
            ("peer-a", "TTS"),
            ("peer-b", "TTS"),
            ("peer-c", "TTS"),
        ]
        assert inner_bus.request.await_count == 0
        assert routing_table.resolve.call_args.kwargs["policy_snapshot"] is snapshot
        assert all(call["topic"] == "TTS.Request" for call in registry.candidate_calls)
        assert all(call["policy_snapshot"] is snapshot for call in registry.candidate_calls)
        assert all(
            call["policy_snapshot"].revision == snapshot.revision
            for call in registry.candidate_calls
        )

    @pytest.mark.asyncio
    async def test_remote_request_capacity_failure_reselects_without_dispatching_busy_peer(
        self, inner_bus, routing_table, peer_bridge, mesh_config
    ):
        registry = _FakeLeaseRegistry(["peer-a", "peer-b"], capacity_denied={"peer-a"})
        routing_table._registry = registry
        routing_table.resolve.return_value = RouteDecision(
            target="remote", peer_id="peer-a", module="TTS"
        )
        peer_bridge.call.return_value = QueryResult(ok=True, data={"result": "peer-b"})
        bus = MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)

        result = await bus.request("TTS.Request", FakePayload())

        assert result.ok is True
        peer_bridge.call.assert_awaited_once()
        assert peer_bridge.call.await_args.args[0] == "peer-b"
        assert registry.acquired == [("peer-b", "TTS")]
        assert [(lease.peer_id, lease.module) for lease in registry.released] == [("peer-b", "TTS")]
        assert inner_bus.request.await_count == 0

    @pytest.mark.asyncio
    async def test_error_route(self, mesh_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="error", module="TTS")
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is False
        assert "No remote peer" in result.error

    @pytest.mark.asyncio
    async def test_permission_denied_route_returns_stable_authorization_code(
        self, mesh_bus, routing_table
    ):
        routing_table.resolve.return_value = RouteDecision(
            target="error",
            module="Tooling",
            error_code="selector_permission_denied",
            error_message=(
                "Tooling selector peer/provider 'mobile-peer': "
                "local peer authority does not allow Tooling.ExecuteTool"
            ),
        )

        result = await mesh_bus.request("Tooling.ExecuteTool", FakePayload())

        assert result == QueryResult(ok=False, error="permission_denied")

    @pytest.mark.asyncio
    async def test_none_route(self, mesh_bus, routing_table):
        routing_table.resolve.return_value = RouteDecision(target="none", module="TTS")
        result = await mesh_bus.request("TTS.Request", FakePayload())
        assert result.ok is False


class TestMeshBusStreamRequest:
    """Tests for MeshBus.stream_request()."""

    @pytest.mark.asyncio
    async def test_remote_stream_failure_before_first_chunk_uses_fallback(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        async def failing_remote_stream(*args, **kwargs):
            raise RuntimeError("remote stream unavailable")
            yield "unreachable"

        async def local_stream(*args, **kwargs):
            yield {"delta": "local fallback"}

        routing_table.resolve.return_value = RouteDecision(
            target="remote",
            module="Orchestrator",
            peer_id="peer-gpu",
        )
        routing_table.resolve_fallback.return_value = RouteDecision(
            target="local",
            module="Orchestrator",
        )
        peer_bridge.stream_call = MagicMock(side_effect=failing_remote_stream)
        inner_bus.stream_request = MagicMock(side_effect=local_stream)

        chunks = [
            chunk
            async for chunk in mesh_bus.stream_request(
                "Orchestrator.StreamInferChat",
                FakePayload(),
            )
        ]

        assert chunks == [{"delta": "local fallback"}]
        inner_bus.stream_request.assert_called_once()

    @pytest.mark.asyncio
    async def test_remote_stream_failure_after_first_chunk_raises_without_fallback(
        self, mesh_bus, inner_bus, routing_table, peer_bridge
    ):
        async def failing_remote_stream(*args, **kwargs):
            yield {"delta": "remote first"}
            raise RuntimeError("remote stream interrupted")

        async def local_stream(*args, **kwargs):
            yield {"delta": "must not fallback"}

        routing_table.resolve.return_value = RouteDecision(
            target="remote",
            module="Orchestrator",
            peer_id="peer-gpu",
        )
        routing_table.resolve_fallback.return_value = RouteDecision(
            target="local",
            module="Orchestrator",
        )
        peer_bridge.stream_call = MagicMock(side_effect=failing_remote_stream)
        inner_bus.stream_request = MagicMock(side_effect=local_stream)

        chunks = []
        with pytest.raises(RuntimeError, match="remote stream interrupted"):
            async for chunk in mesh_bus.stream_request(
                "Orchestrator.StreamInferChat",
                FakePayload(),
            ):
                chunks.append(chunk)

        assert chunks == [{"delta": "remote first"}]
        routing_table.resolve_fallback.assert_not_called()
        inner_bus.stream_request.assert_not_called()

    @pytest.mark.asyncio
    async def test_remote_stream_aclose_releases_capacity_lease(
        self, inner_bus, routing_table, peer_bridge, mesh_config
    ):
        async def long_remote_stream(*args, **kwargs):
            yield {"delta": "first"}
            yield {"delta": "second"}

        registry = _FakeLeaseRegistry(["peer-gpu"])
        routing_table._registry = registry
        routing_table.resolve.return_value = RouteDecision(
            target="remote",
            module="Orchestrator",
            peer_id="peer-gpu",
        )
        peer_bridge.stream_call = MagicMock(side_effect=long_remote_stream)
        bus = MeshBus(inner_bus, routing_table, peer_bridge, mesh_config)

        stream = bus.stream_request("Orchestrator.StreamInferChat", FakePayload())
        first = await stream.__anext__()
        await stream.aclose()

        assert first == {"delta": "first"}
        assert registry.acquired == [("peer-gpu", "Orchestrator")]
        assert [(lease.peer_id, lease.module) for lease in registry.released] == [
            ("peer-gpu", "Orchestrator")
        ]

    @pytest.mark.asyncio
    async def test_orchestrator_stream_infer_explicit_selector_error_raises_without_local_stream(
        self, mesh_bus, inner_bus, routing_table
    ):
        from app.shared.contracts.models.orchestrator import (
            OrchestratorChatMessage,
            OrchestratorInferChatRequest,
            OrchestratorMethods,
        )

        selector = MeshAddressSelector(peer_id="assistant-peer")
        inner_bus.stream_request = AsyncMock()
        routing_table.resolve.return_value = RouteDecision(
            target="error",
            module="Orchestrator",
            selector=selector,
            error_code="selector_target_failed",
            error_message="Orchestrator explicit selector target failed; transparent fallback skipped",
        )

        with pytest.raises(RuntimeError, match="transparent fallback skipped"):
            _ = [
                chunk
                async for chunk in mesh_bus.stream_request(
                    OrchestratorMethods.STREAM_INFER_CHAT,
                    OrchestratorInferChatRequest(
                        messages=[OrchestratorChatMessage(role="user", content="hello")],
                        stream=True,
                        mesh_selector=selector,
                    ),
                )
            ]

        routing_table.resolve.assert_called_once()
        assert routing_table.resolve.call_args.args == (OrchestratorMethods.STREAM_INFER_CHAT,)
        assert routing_table.resolve.call_args.kwargs == {
            "routing_config": ANY,
            "mesh_config": ANY,
            "selector": selector,
            "policy_snapshot": ANY,
        }
        inner_bus.stream_request.assert_not_called()
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_orchestrator_stream_infer_explicit_selector_none_raises_without_local_stream(
        self, mesh_bus, inner_bus, routing_table
    ):
        from app.shared.contracts.models.orchestrator import (
            OrchestratorChatMessage,
            OrchestratorInferChatRequest,
            OrchestratorMethods,
        )

        selector = MeshAddressSelector(peer_id="assistant-peer")
        inner_bus.stream_request = AsyncMock()
        routing_table.resolve.return_value = RouteDecision(
            target="none",
            module="Orchestrator",
            selector=selector,
            error_code="selector_target_failed",
            error_message="Orchestrator explicit selector target failed; transparent fallback skipped",
        )

        with pytest.raises(RuntimeError, match="No route available"):
            _ = [
                chunk
                async for chunk in mesh_bus.stream_request(
                    OrchestratorMethods.STREAM_INFER_CHAT,
                    OrchestratorInferChatRequest(
                        messages=[OrchestratorChatMessage(role="user", content="hello")],
                        stream=True,
                        mesh_selector=selector,
                    ),
                )
            ]

        routing_table.resolve.assert_called_once()
        assert routing_table.resolve.call_args.args == (OrchestratorMethods.STREAM_INFER_CHAT,)
        assert routing_table.resolve.call_args.kwargs == {
            "routing_config": ANY,
            "mesh_config": ANY,
            "selector": selector,
            "policy_snapshot": ANY,
        }
        inner_bus.stream_request.assert_not_called()
        inner_bus.request.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_local_stream_infer_requires_native_stream_request_without_request_fallback(
        self, routing_table, peer_bridge, mesh_config
    ):
        """BullMQ-like local buses must not serialize async generators via request fallback."""
        from app.shared.contracts.models.orchestrator import (
            OrchestratorChatMessage,
            OrchestratorInferChatRequest,
            OrchestratorMethods,
        )

        class BullMQLikeBus:
            def __init__(self):
                self.request = AsyncMock(return_value=QueryResult(ok=True, data={"chunks": []}))
                self.publish = AsyncMock()
                self.subscribe = MagicMock()
                self.unsubscribe = MagicMock()

            async def start(self):
                pass

            async def stop(self):
                pass

        inner = BullMQLikeBus()
        routing_table.resolve.return_value = RouteDecision(
            target="local",
            module="Orchestrator",
        )
        bus = MeshBus(inner, routing_table, peer_bridge, mesh_config)

        with pytest.raises(RuntimeError, match="native stream_request"):
            _ = [
                chunk
                async for chunk in bus.stream_request(
                    OrchestratorMethods.STREAM_INFER_CHAT,
                    OrchestratorInferChatRequest(
                        messages=[OrchestratorChatMessage(role="user", content="hello")],
                        stream=True,
                    ),
                )
            ]

        inner.request.assert_not_awaited()


class TestMeshBusSubscribe:
    """Tests for MeshBus.subscribe()."""

    def test_subscribe_delegates_to_inner(self, mesh_bus, inner_bus):
        handler = MagicMock()
        mesh_bus.subscribe("TTS.*", handler)
        inner_bus.subscribe.assert_called_once_with("TTS.*", handler, event=False)

    def test_subscribe_forwards_event_intent_to_inner(self, mesh_bus, inner_bus):
        handler = MagicMock()
        mesh_bus.subscribe("TTS.Started", handler, event=True)
        inner_bus.subscribe.assert_called_once_with("TTS.Started", handler, event=True)


class TestMeshBusLifecycle:
    """Tests for MeshBus start/stop."""

    @pytest.mark.asyncio
    async def test_start_delegates(self, mesh_bus, inner_bus):
        await mesh_bus.start()
        inner_bus.start.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_stop_delegates(self, mesh_bus, inner_bus):
        await mesh_bus.stop()
        inner_bus.stop.assert_awaited_once()
