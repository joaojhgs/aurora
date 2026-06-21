# PER-145 Mesh Distributed Tracing and Audit Plan

## Scope

Issue: PER-145 `[MESH][P6-T01] Add distributed tracing, correlation IDs, and mesh audit views`.

Source context read:
- Multica issue description, labels, metadata, QA approval comment, and architect rejection comment.
- Root `AGENTS.md`, plus `app/messaging/AGENTS.md`, `app/services/AGENTS.md`, `app/services/gateway/AGENTS.md`, `app/services/auth/AGENTS.md`, `app/shared/AGENTS.md`, `app/shared/contracts/AGENTS.md`, and `tests/AGENTS.md`.
- Existing docs: `docs/SERVICE_METHODS_REFERENCE.md`, `docs/DATA_SHARING_POLICY.md`, and `docs/PEER_PAIRING_FLOW.md`.
- Code paths: `app/messaging/mesh_bus.py`, `app/services/gateway/mesh/peer_bridge.py`, `app/services/gateway/webrtc/rpc.py`, `app/shared/mesh/tracing.py`, `app/shared/services/base_service.py`, `app/services/auth/service.py`.
- Architect follow-up context: PR #42 was rejected because `app/messaging/mesh_bus.py` imported reusable tracing helpers from `app/services/gateway/mesh/tracing.py`, making the messaging layer depend on a concrete Gateway service package. Generic correlation/redaction helpers must live in shared/lower-level code; Gateway-specific RPC audit behavior remains in Gateway.
- Boundary check for the follow-up fix: `app/messaging` and `app/shared` must not import `app.services.gateway.*`.

The issue references `.omx/specs/deep-interview-mesh-distributed-integration.md` and `.omx/multica/mesh-roadmap-tasks/*.md`, but those paths are absent on the checked-out base branch. This plan uses the issue body and currently committed docs/code as the source of truth.

## Acceptance Criteria

- A mesh-routed request/command carries one correlation ID through MeshBus route resolution, PeerBridge JSON-RPC metadata, RPCHandler bus request execution, remote service reply, and PeerBridge response handling.
- Mesh forwarded events preserve correlation ID metadata when delivered on the receiving peer's local bus.
- Access-denied, service-error, timeout, send-failure, and route-error paths include peer/method/correlation metadata in logs or audit details.
- Audit details redact secret-like argument/parameter values and include hashes or shape-preserving metadata sufficient for diagnostics.
- Tests verify correlation ID propagation and audited denial/timeout behavior.

## Implementation Steps

1. Keep generic mesh tracing helpers in shared code (`app/shared/mesh/tracing.py`) for correlation ID generation/extraction, redaction, and audit detail hashing; do not import Gateway service modules from messaging.
2. Extend the bus request interface with an optional `correlation_id` parameter and pass it through LocalBus, BullMQBus, and MeshBus.
3. Update MeshBus to derive or generate correlation IDs, log route decisions with selector/peer/correlation metadata, pass correlation IDs into PeerBridge, and preserve them during fallback.
4. Update PeerBridge JSON-RPC calls/events to include `correlation_id` metadata, and return remote errors/timeouts/send failures with correlation-aware messages/logs.
5. Update RPCHandler to use incoming correlation IDs for remote bus requests, Tooling provenance injection, forwarded events, permission-denial audits, service-error audits, and timeout audits.
6. Update docs with a short correlation-ID debugging section.
7. Add focused tests for PeerBridge message metadata, RPCHandler bus/audit propagation, and MeshBus remote routing propagation.

## Verification

- `uv run pytest tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/integration/test_mesh_routing.py -q`
- `uv run ruff check app/messaging/mesh_bus.py app/messaging/bus.py app/messaging/local_bus.py app/messaging/bullmq_bus.py app/shared/mesh/tracing.py app/services/gateway/mesh/peer_bridge.py app/services/gateway/webrtc/rpc.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/integration/test_mesh_routing.py`
- `git diff --check`
