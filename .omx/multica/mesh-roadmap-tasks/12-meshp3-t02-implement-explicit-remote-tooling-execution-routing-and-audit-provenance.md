## Objective
Allow a caller to execute a specific remote tool on a specific peer/provider while preserving auditability, policy enforcement, and safe failure behavior.

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

Example target:
- A computer peer should be able to call a Raspberry Pi peer's physical-switch tool over the mesh, but only if policy allows that peer/principal/tool/resource combination.

Relevant code anchors:
- `app/services/tooling/service.py` `ExecuteTool`.
- `app/services/orchestrator/graph.py` tool execution.
- `app/messaging/mesh_bus.py` remote request routing.
- `app/services/gateway/webrtc/rpc.py` auth/permission gate.
- `app/shared/auth/permissions.py`.

## Initial implementation plan
1. Extend execute request models to support stable tool/provider selectors while preserving simple local execution.
2. Route explicit remote execution to the selected provider instead of generic module best-provider routing.
3. Enforce policy before execution: peer trust tier, principal permissions, tool safety class, resource selector, confirmation/dry-run requirements, and rate limits.
4. Add audit events with caller peer, caller principal, target peer, tool ID, resource, argument hash/redaction, result status, correlation ID, and denial reason.
5. Return structured errors for missing provider, stale provider, policy denial, timeout, and remote execution failure.

## Acceptance criteria
- Explicit remote tool execution works with mocked remote providers.
- A wrong/unauthorized peer/tool/resource is denied before execution.
- Audit records contain enough provenance without leaking secrets.
- Local tool execution remains backward compatible.

## Suggested verification
- Unit tests for request validation and policy denial.
- Integration tests for explicit remote Tooling execution over MeshBus/PeerBridge mocks.
