## Objective
Clarify what Auth and Config functionality is allowed across the mesh. Pairing and peer management are necessary infrastructure; broad transparent Auth admin or Config mutation should remain non-default and explicit.

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

Observed fact:
- Gateway mesh config currently wires STT/DB/TTS/Tooling/Scheduler/Orchestrator into mesh services, but not Auth/Config, even though some defaults/schema include mesh sharing blocks.
- RPCHandler has special handling for pairing/auth infrastructure methods.

Relevant code anchors:
- `app/services/gateway/service.py`
- `app/services/gateway/webrtc/rpc.py`
- `app/services/auth/service.py`
- `app/services/config/service.py`
- `docs/PEER_PAIRING_FLOW.md`

## Initial implementation plan
1. Document Auth/Config mesh exposure categories: infra-required, read-only diagnostics, admin mutation, never-share.
2. Decide whether Auth/Config `mesh_sharing` config should remain, be hidden, or be implemented with strict explicit behavior.
3. Ensure Gateway config behavior matches docs and schema.
4. Add tests that broad Auth/Config calls are denied unless explicitly enabled and authorized.
5. Update pairing docs to explain infra methods that bypass ordinary service sharing gates.

## Acceptance criteria
- Auth/Config sharing policy is explicit.
- Config schema/defaults do not imply unsupported broad sharing.
- Pairing/login infrastructure remains functional.
- High-risk Auth/Config mutations are not transparently routed by default.

## Suggested verification
- RPC auth/config access tests.
- Config schema validation.
- Docs review.
