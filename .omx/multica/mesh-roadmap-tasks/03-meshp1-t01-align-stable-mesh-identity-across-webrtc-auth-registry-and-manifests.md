## Objective
Remove identity ambiguity between ephemeral WebRTC signaling IDs and stable mesh identities. Multi-peer reconnection, persisted credentials, registry records, and manifests should all refer to the correct stable peer identity where security or policy depends on identity.

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
- The roadmap investigation found evidence that WebRTC signaling peer IDs may be session-ephemeral while Auth/DB mesh identities are stable.
- Persisted tokens and peer registry updates need stable IDs to avoid multi-peer confusion.

Relevant code anchors:
- `app/services/gateway/webrtc/rtc_client.py`
- `app/services/gateway/service.py` `_start_mesh`
- `app/services/auth/service.py` mesh identity/peer methods
- `app/shared/contracts/models/mesh.py`

## Initial implementation plan
1. Trace all peer ID fields and meanings: signaling session peer, stable mesh peer, principal/user/device IDs, manifest peer ID, registry peer ID.
2. Document the canonical identity model in code comments and docs.
3. Update WebRTC auth/manifest paths so stable peer ID is available and used for persisted credentials, registry records, manifests, ACL checks, and diagnostics.
4. Keep ephemeral signaling IDs only where transport/session addressing requires them.
5. Add migration-safe handling for existing saved credentials keyed by older IDs.

## Acceptance criteria
- Stable peer ID is consistently used for persisted credential lookup and mesh policy.
- Session/signaling ID is clearly separated from stable identity.
- Manifest and peer registry records expose stable identity.
- Tests cover reconnect and manifest exchange with distinct stable vs session IDs.

## Suggested verification
- Unit tests for identity mapping.
- Integration/mocked test with two peers reconnecting after signaling ID changes.
