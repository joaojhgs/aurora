## Objective
Ensure bilateral pairing completes independently for each peer. A saved credential for one peer must not cause reverse pairing to be skipped for another peer.

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
- Investigation found reverse pairing checks whether any saved token exists, not whether the current peer already has a valid saved token.
- This can break multi-peer bilateral trust establishment.

Relevant code anchors:
- `app/services/gateway/webrtc/rtc_client.py` `_reverse_pairing`.
- `docs/MESH_PAIRING_FIX_PLAN.md` bilateral pairing expectations.
- `docs/PEER_PAIRING_FLOW.md` pairing flow documentation.

## Initial implementation plan
1. Change reverse pairing precondition from “any saved tokens exist” to “a valid token exists for this stable remote peer”.
2. Reuse the peer-scoped identity model from `[MESH][P1-T01]` and saved-token work from `[MESH][P1-T02]`.
3. Add tests for peer A already paired, peer B newly authenticating, and reverse pairing still starting for peer B.
4. Update docs to describe peer-specific bilateral pairing state.

## Acceptance criteria
- Reverse pairing skip is peer-specific.
- Existing single-peer flow still works.
- Multi-peer reverse pairing is covered by tests.
- Logs explain why reverse pairing starts or skips for each peer.

## Suggested verification
- Unit tests for `_reverse_pairing` conditions.
- Mocked bilateral pairing integration flow.
