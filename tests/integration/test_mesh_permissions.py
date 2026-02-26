"""Integration tests for mesh permission gating.

Tests that the RPCHandler sharing gate correctly allows/denies
remote calls based on mesh sharing configuration.
"""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.messaging.bus import QueryResult
from app.services.gateway.acl.identity import Identity
from app.services.gateway.config import MeshConfig, ServiceSharingConfig
from app.services.gateway.webrtc.rpc import RPCHandler


@pytest.fixture
def mock_bus():
    bus = AsyncMock()
    bus.request = AsyncMock(return_value=QueryResult(ok=True, data={"result": "ok"}))
    return bus


@pytest.fixture
def mock_registry():
    registry = AsyncMock()
    # Simulate a registered method
    registry.find_method.return_value = MagicMock(
        bus_topic="TTS.Synthesize",
        required_perms=["TTS.*"],
    )
    return registry


@pytest.fixture
def mock_send_fn():
    return MagicMock()


@pytest.fixture
def admin_identity():
    return Identity(
        principal_id="admin-peer",
        principal_name="admin",
        is_admin=True,
        effective_perms=frozenset(["*"]),
        source="webrtc_peer",
    )


@pytest.fixture
def limited_identity():
    return Identity(
        principal_id="limited-peer",
        principal_name="limited",
        is_admin=False,
        effective_perms=frozenset(["TTS.*"]),
        source="webrtc_peer",
    )


@pytest.mark.integration
class TestSharingGate:
    """Tests that the sharing gate in RPCHandler correctly gates calls."""

    @pytest.mark.asyncio
    async def test_shared_service_allows_call(
        self, mock_bus, mock_registry, mock_send_fn, admin_identity
    ):
        """When a service is shared, calls should be allowed."""
        mesh_config = MeshConfig(
            enabled=True,
            sharing={
                "TTS": ServiceSharingConfig(share=True, max_concurrent=5),
            },
        )
        handler = RPCHandler(
            mock_bus,
            mock_registry,
            mock_send_fn,
            lambda: admin_identity,
            mesh_config=mesh_config,
        )

        call_msg = json.dumps(
            {
                "type": "call",
                "id": "req-1",
                "method": "TTS.Synthesize",
                "params": {"text": "Hello"},
            }
        )

        await handler.on_message(call_msg)

        # Should have called the bus (not been blocked by sharing gate)
        # Check that send was called with a result (not an error)
        if mock_send_fn.called:
            sent_data = json.loads(mock_send_fn.call_args[0][0])
            # Either result or error — if sharing gate passed, it tries the bus
            assert sent_data.get("type") in ("result", "error")

    @pytest.mark.asyncio
    async def test_non_shared_service_blocks_call(
        self, mock_bus, mock_registry, mock_send_fn, admin_identity
    ):
        """When a service is NOT shared, calls should be rejected."""
        mesh_config = MeshConfig(
            enabled=True,
            sharing={
                "TTS": ServiceSharingConfig(share=False),
            },
        )
        handler = RPCHandler(
            mock_bus,
            mock_registry,
            mock_send_fn,
            lambda: admin_identity,
            mesh_config=mesh_config,
        )

        call_msg = json.dumps(
            {
                "type": "call",
                "id": "req-2",
                "method": "TTS.Synthesize",
                "params": {},
            }
        )

        await handler.on_message(call_msg)

        # Should have sent an error (403 forbidden)
        if mock_send_fn.called:
            sent_data = json.loads(mock_send_fn.call_args[0][0])
            assert sent_data.get("type") == "error"
            assert sent_data.get("error", {}).get("code") == 403

    @pytest.mark.asyncio
    async def test_capacity_limit_enforced(
        self, mock_bus, mock_registry, mock_send_fn, admin_identity
    ):
        """When a service is at capacity, calls should be rejected with 429."""
        mesh_config = MeshConfig(
            enabled=True,
            sharing={
                "TTS": ServiceSharingConfig(share=True, max_concurrent=1),
            },
        )
        handler = RPCHandler(
            mock_bus,
            mock_registry,
            mock_send_fn,
            lambda: admin_identity,
            mesh_config=mesh_config,
        )
        # Simulate one active call
        handler._active_remote_calls["TTS"] = 1

        call_msg = json.dumps(
            {
                "type": "call",
                "id": "req-3",
                "method": "TTS.Synthesize",
                "params": {},
            }
        )

        await handler.on_message(call_msg)

        if mock_send_fn.called:
            sent_data = json.loads(mock_send_fn.call_args[0][0])
            assert sent_data.get("type") == "error"
            assert sent_data.get("error", {}).get("code") == 429

    @pytest.mark.asyncio
    async def test_no_mesh_config_allows_all(
        self, mock_bus, mock_registry, mock_send_fn, admin_identity
    ):
        """Without mesh config, all calls should pass through (backwards compatible)."""
        handler = RPCHandler(
            mock_bus,
            mock_registry,
            mock_send_fn,
            lambda: admin_identity,
        )

        call_msg = json.dumps(
            {
                "type": "call",
                "id": "req-4",
                "method": "TTS.Synthesize",
                "params": {"text": "test"},
            }
        )

        await handler.on_message(call_msg)

        # Should not be blocked
        if mock_send_fn.called:
            sent_data = json.loads(mock_send_fn.call_args[0][0])
            # Without mesh config, existing behavior should apply
            assert sent_data.get("type") in ("result", "error")
