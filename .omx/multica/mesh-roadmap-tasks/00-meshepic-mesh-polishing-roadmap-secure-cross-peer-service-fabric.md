## Objective
Coordinate the full mesh-polishing roadmap as a parent issue. The outcome is a secure and observable peer service fabric where Aurora peers can safely share selected services, tools, data capabilities, and device-specific resources.

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

## Scope
This epic tracks the child tasks from foundation regression safety through identity hardening, capability graph/addressing, remote Tooling/Orchestrator integration, DB/data sharing design, module-specific integrations, and operational readiness.

## Definition of done
- Every child `[MESH][P#]` task has either been completed or intentionally deferred with a documented reason.
- Mesh functionality has a validated safety baseline for multi-peer pairing, service negotiation, routing, and observability.
- The next implementation roadmap can be created from the completed child-task evidence.
