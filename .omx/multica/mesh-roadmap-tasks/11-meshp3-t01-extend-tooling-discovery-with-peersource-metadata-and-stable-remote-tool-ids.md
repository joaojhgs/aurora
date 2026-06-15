## Objective
Make Tooling discovery return enough metadata for an orchestrator to safely bind local and remote tools in a single view while preserving provenance and avoiding name collisions.

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

Current baseline:
- Orchestrator requests tools over the bus.
- Tooling exposes `GetTools` as `both`.
- Current tool payloads are oriented around local tool names/descriptions and do not fully encode peer/source/provenance/policy.

Relevant code anchors:
- `app/services/tooling/service.py`
- `app/shared/contracts/models/tooling.py`
- `app/services/orchestrator/agents/chatbot.py`
- Capability graph tasks `[MESH][P2-T01]` through `[MESH][P2-T03]`.

## Initial implementation plan
1. Add stable tool identity fields: local name, provider peer ID, provider service instance, global tool ID, namespace/display name.
2. Include metadata: source type, execution location, safety class, required permissions, confirmation requirement, rate-limit hints, schema, description, and provenance.
3. Define name-collision policy: namespace remote tools, expose aliases, or require explicit selection.
4. Update Tooling serialization to preserve backward compatibility where possible.
5. Add docs showing examples like `raspi-lab.switch_on` and `workstation.gpu_search`.

## Acceptance criteria
- Remote tools are not confused with local tools of the same name.
- Orchestrator can display or bind tools with provenance.
- Tool identity is stable across rediscovery when peer identity is stable.
- Tooling discovery response remains typed and tested.

## Suggested verification
- Contract/model tests.
- Tooling discovery tests with local + two remote providers and colliding tool names.
