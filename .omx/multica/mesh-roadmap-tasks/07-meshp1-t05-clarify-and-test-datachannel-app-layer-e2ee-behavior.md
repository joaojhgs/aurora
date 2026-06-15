## Objective
Resolve ambiguity around `enable_app_layer_e2ee`. If app-layer E2EE is intended for DataChannel RPC, outbound send paths must seal payloads and inbound paths must consistently unseal them. If WebRTC DTLS is the intended protection, config/docs should not imply an additional DataChannel encryption layer.

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
- Investigation found inbound binary decrypt logic, while common send paths send JSON strings directly.
- Signaling encryption and DataChannel transport security should be documented separately.

Relevant code anchors:
- `app/services/gateway/webrtc/rtc_client.py`
- `app/services/gateway/mesh/peer_bridge.py`
- `app/services/gateway/utils/crypto.py`
- `docs/GATEWAY.md`

## Initial implementation plan
1. Trace all DataChannel send/receive paths: auth messages, RPC calls, results, errors, manifests, ping/pong, capacity updates, mesh events.
2. Decide the supported modes: DTLS-only, app-layer E2EE, or both.
3. Align implementation with the chosen mode and fail safely on mixed-mode peers.
4. Add compatibility diagnostics in manifest/ACK or mesh status if E2EE settings mismatch.
5. Update docs and tests.

## Acceptance criteria
- Config option behavior is unambiguous.
- Send and receive paths are symmetric for the chosen mode.
- Mismatched peers fail safely or negotiate a documented fallback.
- Tests cover encrypted and non-encrypted paths.

## Suggested verification
- Unit tests for `send_to_peer`/receive encoding behavior.
- Mocked peer bridge RPC round trip under both modes.
