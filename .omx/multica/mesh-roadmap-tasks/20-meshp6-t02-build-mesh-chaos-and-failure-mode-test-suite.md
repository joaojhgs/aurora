## Objective
Validate safe degraded behavior under realistic distributed-system failure modes. Mesh should handle peer disconnects, stale manifests, service restarts, partial capacity, latency changes, token expiry, denied permissions, and fallback routing without unsafe behavior.

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

Relevant code anchors:
- `app/messaging/mesh_bus.py`
- `app/services/gateway/mesh/peer_registry.py`
- `app/services/gateway/mesh/routing_table.py`
- `app/services/gateway/mesh/latency.py`
- `app/services/gateway/registry_aggregator.py`
- Existing tests under `tests/unit/gateway/` and `tests/integration/`.

## Initial implementation plan
1. Define chaos scenarios and expected safe outcomes.
2. Use mocks/fakes where full WebRTC is too heavy for unit/integration tests.
3. Add tests for provider disappearing mid-request, stale manifest exclusion, capacity rejection, fallback provider selection, auth token expiry, permission denial, and service reannouncement after restart.
4. Add regression tests for no duplicate event loops and no mesh-forward loops.
5. Keep tests deterministic and fast enough for CI.

## Acceptance criteria
- Failure scenarios have explicit expected behavior.
- Tests cover both successful fallback and safe hard failure.
- Unauthorized or stale peers are never used after policy/status changes.
- CI-friendly suite can be run without real external MQTT/WebRTC brokers.

## Suggested verification
- New unit/integration chaos suite.
- Existing targeted mesh/gateway suite remains green.
