## Objective
Enable Aurora to see capabilities from multiple peers at once. This is essential for the target where one computer can use tools from multiple peer devices, such as a Raspberry Pi with physical-switch tools and another workstation with GPU/LLM capabilities.

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
- `PeerRegistry.get_best_provider()` selects one best provider for a module.
- Remote Tooling needs aggregation of local and remote tools across all authorized peers.

Relevant code anchors:
- `app/services/gateway/mesh/peer_registry.py`
- `app/services/gateway/mesh/routing_table.py`
- `app/services/gateway/mesh/negotiation.py`
- Future capability graph from `[MESH][P2-T01]`.

## Initial implementation plan
1. Add APIs to list all eligible providers for a service/capability rather than only the best provider.
2. Include filtering by trust tier, permissions, version, required capabilities, latency, capacity, and explicit selectors.
3. Preserve best-provider selection for legacy transparent routing.
4. Use aggregation APIs as the basis for remote Tooling discovery and DB namespace discovery.
5. Add route diagnostics explaining why providers were included or excluded.

## Acceptance criteria
- Multiple Tooling providers can be represented and queried simultaneously.
- Legacy `get_best_provider` behavior remains available.
- Exclusion reasons are testable and visible in diagnostics.
- Provider aggregation respects peer allowlists and capability/version policy.

## Suggested verification
- PeerRegistry unit tests with 3+ peers providing overlapping services.
- Diagnostics snapshot tests for provider inclusion/exclusion.
