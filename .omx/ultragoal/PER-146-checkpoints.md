# PER-146 Ultragoal Checkpoints

## Goal

Build a deterministic mesh chaos and failure-mode test suite for PER-146, scoped to tests and directly related planning artifacts.

## Checkpoints

- Planned: read issue, metadata, comments, root/subsystem AGENTS guides, current mesh routing/failover tests, MeshBus, RoutingTable, PeerRegistry, RPCHandler, and available `.omx` context.
- Implemented: added `tests/integration/test_mesh_chaos_failure_modes.py` with deterministic coverage for provider disconnects, fallback to another provider, stale selectors, policy denial, capacity rejection, network-only hard failure, anonymous/expired RPC identity rejection, latency route changes, service reannouncement, and mesh-forward loop prevention.
- Verified: `UV_CACHE_DIR=/tmp/uv-cache UV_LINK_MODE=copy ~/.local/bin/uv run --extra dev --extra service-db --extra test-all pytest tests/integration/test_mesh_chaos_failure_modes.py -q` passed: 11 passed, 4 warnings.
- Verified: `UV_CACHE_DIR=/tmp/uv-cache UV_LINK_MODE=copy ~/.local/bin/uv run --extra dev ruff check tests/integration/test_mesh_chaos_failure_modes.py` passed.
- Verified: `git diff --check` passed.
- Verified: `UV_CACHE_DIR=/tmp/uv-cache UV_LINK_MODE=copy ~/.local/bin/uv run --extra dev --extra service-db --extra test-all pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_rtc_auth_enforcement.py tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_failover.py tests/integration/test_mesh_chaos_failure_modes.py -q` passed: 119 passed, 14 warnings.
- Note: `tests/test_scheduler.db` was already modified on entry and remains untouched by PER-146 changes.
