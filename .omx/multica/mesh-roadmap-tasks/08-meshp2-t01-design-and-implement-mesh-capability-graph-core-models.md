## Objective
Move beyond module-level provider selection by introducing a first-class capability graph. The graph should describe what each peer can provide, under which trust/policy constraints, and how callers should address those capabilities.

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

Current limitation:
- `MeshBus` and `RoutingTable` select a provider for a whole service module.
- Desired remote Tooling and DB/data sharing require provider aggregation and explicit resource identity.

Relevant code anchors:
- `app/services/gateway/mesh/peer_registry.py`
- `app/services/gateway/mesh/negotiation.py`
- `app/shared/contracts/models/mesh.py`
- `app/shared/contracts/models/gateway.py`

## Initial implementation plan
1. Define typed capability graph models: peer, service instance, method, tool, resource, safety class, trust tier, policy requirements, latency/capacity, version, capabilities, and provenance.
2. Decide whether graph state lives in Gateway only, Auth/DB persistence, or a shared registry module.
3. Populate graph from local registry, remote manifests, Tooling discovery metadata, and future DB/resource descriptors.
4. Expose read-only graph query methods for Gateway/Orchestrator diagnostics.
5. Keep backward-compatible module-level routing while graph consumers are introduced.

## Acceptance criteria
- Capability graph can represent multiple peers providing the same module with different capabilities.
- Graph includes enough metadata for remote Tooling, DB namespaces, hardware tools, and scheduler ownership.
- Existing routing continues to work.
- Graph query output is redacted and safe for diagnostics.

## Suggested verification
- Model validation tests.
- Graph construction tests from local and remote manifests.
