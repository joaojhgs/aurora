## Objective
Introduce hybrid addressing primitives that let callers choose explicit peers/resources when needed without breaking transparent module routing for simple local-like dependencies.

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

Roadmap decision:
- Target addressing model is hybrid.
- Transparent routing remains useful for low-risk service dependencies.
- Explicit peer/resource addressing is required for tools, DB/data, hardware controls, scheduler ownership, remote playback, and privacy-sensitive data.

Relevant code anchors:
- `app/messaging/mesh_bus.py`
- `app/services/gateway/mesh/routing_table.py`
- `app/shared/contracts/models/mesh.py`
- `app/shared/contracts/models/tooling.py`
- `app/shared/contracts/models/db.py`

## Initial implementation plan
1. Define common selector models: `peer_id`, `provider_id`, `service_instance_id`, `resource_namespace`, `tool_id`, `hardware_target`, `data_scope`.
2. Decide where selectors live in request payloads vs envelope metadata.
3. Update routing resolution to honor explicit selectors before transparent routing preferences.
4. Add clear errors when explicit selectors reference missing, unauthorized, stale, or incompatible providers.
5. Document which services remain transparent and which require explicit selectors.

## Acceptance criteria
- Explicit selector paths are typed and validated.
- Transparent routing remains backward compatible.
- Selector failures return actionable errors.
- Safety-sensitive categories can require explicit selectors by policy.

## Suggested verification
- Routing table tests for explicit peer/resource selection.
- MeshBus tests for transparent vs explicit routing precedence.
