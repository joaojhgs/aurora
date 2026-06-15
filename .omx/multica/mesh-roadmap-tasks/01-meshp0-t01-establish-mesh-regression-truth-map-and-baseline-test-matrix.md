## Objective
Capture the current working mesh state as a regression truth map before making additional changes. This prevents later polishing work from accidentally regressing WebRTC pairing, manifest negotiation, mesh routing, service announcements, or permission gates.

## Context
This task is part of the Aurora mesh-polishing roadmap derived from `.omx/specs/deep-interview-mesh-distributed-integration.md`.

Current confirmed baseline:
- Targeted mesh/gateway tests previously passed: `88 passed, 13 warnings`.
- `MeshBus` already routes commands and mesh events through routing/peer bridge paths.
- WebRTC pairing, manifest exchange, service negotiation, and service sharing are implemented to a working baseline.
- Orchestrator already uses the bus for Tooling discovery/execution, and Tooling exposes `GetTools`/`ExecuteTool` as mesh-shareable methods.

Roadmap constraints:
- Preserve Aurora's privacy-first, message-bus-first microservice architecture.
- Use pragmatic security tiers across home LAN/VPN, Docker/process clusters, and internet-crossing peers.
- Use hybrid addressing: transparent routing is allowed for low-risk service dependencies, but explicit peer/resource addressing is required for tools, DB/data, hardware, scheduler ownership, remote playback, and safety-sensitive actions.
- Prefer existing contracts/utilities and typed topic constants; avoid exposing raw internal/admin capabilities by default.

Important anchors:
- `tests/unit/gateway/test_negotiation.py`
- `tests/unit/gateway/test_routing_table.py`
- `tests/unit/gateway/test_peer_bridge.py`
- `tests/unit/gateway/test_rpc.py`
- `tests/unit/gateway/test_rtc_auth_enforcement.py`
- `tests/integration/test_mesh_routing.py`
- `tests/integration/test_mesh_permissions.py`
- `tests/integration/test_mesh_failover.py`

## Initial implementation plan
1. Inventory existing gateway/mesh unit and integration tests and map each to the feature it proves.
2. Add a markdown truth map under `docs/` or `.omx/plans/` describing current expected behavior for pairing, authentication, manifests, routing, fallback, and permissions.
3. Identify uncovered assertions for multi-peer identity, peer-scoped tokens, manifest ACK diagnostics, config schema parity, service re-announcement, and DataChannel E2EE behavior.
4. Add targeted TODO test cases or pending test-plan sections for uncovered areas.
5. Ensure all existing targeted tests still pass unchanged before downstream work starts.

## Acceptance criteria
- A regression matrix exists and references concrete tests/files.
- Current supported behavior is distinguished from inferred or desired behavior.
- Existing targeted mesh/gateway suite passes.
- Uncovered areas are listed as follow-up test tasks rather than silently assumed.

## Suggested verification
- `uv run pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_rtc_auth_enforcement.py tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_failover.py -q`
