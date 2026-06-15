## Objective
Make the current mesh state inspectable. Operators and developers need a single diagnostic surface that explains local mesh identity, connected peers, negotiated services, route decisions, compatibility failures, capacity, active calls, and recent ping/latency state.

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
- `app/services/gateway/service.py` mesh startup and component wiring.
- `app/services/gateway/mesh/peer_registry.py` peer/service/capacity state.
- `app/services/gateway/mesh/routing_table.py` route decisions and fallback.
- `app/services/gateway/mesh/negotiation.py` manifests and compatibility ACKs.
- `docs/GATEWAY.md` for gateway API documentation.

## Initial implementation plan
1. Decide whether the first diagnostic surface is a Gateway endpoint, internal contract method, CLI-friendly JSON dump, or all of the above.
2. Define a typed response model with local mesh identity, WebRTC status, peer list, peer statuses, negotiated services, manifests/ACK compatibility diagnostics, route preferences, and active remote calls.
3. Add read-only implementation with no mutation side effects.
4. Include safe redaction: never expose tokens, secrets, broker passwords, or raw credentials.
5. Document how to use the diagnostic output to troubleshoot service sharing and routing.

## Acceptance criteria
- A developer can answer: “which peer provides Tooling/DB/TTS and why did this route go local/remote/fail?”
- Secrets are redacted.
- Stale/negotiated/authenticated peer states are visible.
- Compatibility failures are visible without searching logs.
- The diagnostic surface is covered by tests or snapshot assertions.

## Suggested verification
- Unit tests around serialization/redaction.
- Manual or integration smoke test with at least one mocked negotiated peer.
