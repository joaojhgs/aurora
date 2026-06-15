## Objective
Prevent wrong-token reuse when multiple peers exist. Returning-peer authentication should select the token for the specific remote peer, not the first saved token in memory.

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

Observed risk:
- Investigation found a channel-open path that selects `next(iter(self._saved_auth_tokens.values()), None)`, which is only safe for a single-peer mesh.
- Multi-peer topologies are explicitly in scope.

Relevant code anchors:
- `app/services/gateway/webrtc/rtc_client.py` saved token send path.
- `app/services/auth/service.py` mesh credential persistence methods.
- `app/services/db/service.py` mesh credential storage methods.

## Initial implementation plan
1. Define saved credential keying by stable remote peer ID and, if necessary, room/signaling context.
2. During channel open, resolve the remote stable peer identity before sending a saved token; if not known, use a safe handshake to request/derive identity without leaking unrelated tokens.
3. Remove global “first token” behavior.
4. Add explicit logging/diagnostics for token lookup miss, peer mismatch, revoked token, and successful peer-scoped re-auth.
5. Add tests for two saved peers and ensure peer A never receives peer B's token.

## Acceptance criteria
- Saved token lookup is peer-specific.
- Multi-peer reconnects authenticate with the correct token.
- Missing or ambiguous peer identity fails safe into pairing rather than sending a random token.
- Tests cover two or more saved peer credentials.

## Suggested verification
- Unit tests around token map lookup and channel-open auth.
- Integration-style mocked RTCClient test with two peers.
