## Objective
Improve operational observability for cross-peer workflows. A remote tool call or DB query should be traceable across local orchestrator, MeshBus route resolution, PeerBridge, WebRTC RPC, remote service method, audit logging, and response handling.

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
- `app/services/gateway/mesh/peer_bridge.py`
- `app/services/gateway/webrtc/rpc.py`
- `app/shared/services/base_service.py`
- `app/services/auth/service.py` audit methods.

## Initial implementation plan
1. Standardize correlation ID propagation across MeshBus, PeerBridge, WebRTC messages, and remote bus envelopes.
2. Include route decision metadata and peer IDs in debug logs and audit events.
3. Add a distributed audit query/view for mesh actions and denials.
4. Redact sensitive arguments while preserving hashes and enough metadata for debugging.
5. Document how to debug a failed remote action using correlation IDs.

## Acceptance criteria
- A single correlation ID can connect local request, remote RPC, service execution, and result/error.
- Access denied and timeout paths are auditable.
- Sensitive arguments and tokens are not logged raw.
- Tests verify correlation ID propagation.

## Suggested verification
- Unit tests for envelope/message correlation fields.
- Integration test with a mocked remote call and audit capture.
