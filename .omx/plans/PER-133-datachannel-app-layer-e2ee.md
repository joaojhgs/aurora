# PER-133 DataChannel App-Layer E2EE Plan

## Requirements Summary

- Source issue: PER-133, `[MESH][P1-T05] Clarify and test DataChannel app-layer E2EE behavior`.
- Scope is limited to WebRTC DataChannel payload encoding/decoding, mismatch behavior, directly affected tests, and gateway/pairing docs.
- Local branch is missing the referenced `.omx/specs/deep-interview-mesh-distributed-integration.md` and `.omx/multica/mesh-roadmap-tasks/` artifacts, so the issue body and present docs/code are the source of truth.

## Decision

Support both configured modes explicitly:

- `services.gateway.webrtc.enable_app_layer_e2ee=false`: send JSON text over WebRTC DataChannels and rely on WebRTC DTLS plus authenticated peer gates.
- `services.gateway.webrtc.enable_app_layer_e2ee=true`: seal all RTCClient-managed DataChannel JSON messages with AEAD using the room data key and send them as binary frames.

No automatic plaintext fallback is allowed when app-layer E2EE is enabled; plaintext inbound messages are treated as a peer configuration mismatch and dropped.

## Implementation Steps

1. Centralize DataChannel send encoding in `app/services/gateway/webrtc/rtc_client.py` so RPC calls, auth messages, manifests, ping/pong, capacity updates, and forwarded events use the same mode.
2. Centralize inbound DataChannel decoding in `rtc_client.py`; when E2EE is enabled require binary AEAD frames, and when disabled parse plaintext JSON while logging binary decode failures.
3. Add unit tests in `tests/unit/gateway/` covering plaintext send, encrypted send/decrypt, encrypted inbound handling, and plaintext mismatch drop.
4. Update `docs/GATEWAY.md` and `docs/PEER_PAIRING_FLOW.md` to distinguish signaling encryption, WebRTC DTLS, and optional app-layer DataChannel E2EE.

## Acceptance Criteria

- Config option behavior is unambiguous in code and docs.
- Outbound/inbound paths are symmetric for both modes.
- Mismatched peers fail safely by dropping undecodable or plaintext-when-encrypted messages.
- Tests cover encrypted and non-encrypted DataChannel paths.

## Verification

- `uv run pytest tests/unit/gateway/test_rtc_client_e2ee.py tests/unit/gateway/test_rtc_client_auth.py tests/unit/gateway/test_rtc_auth_enforcement.py -q`
- If time allows, run the targeted mesh/gateway subset from the issue handoff.
