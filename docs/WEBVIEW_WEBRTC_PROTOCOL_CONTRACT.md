# WebView WebRTC Thin-Shell Protocol Contract

**Status:** Current source of truth

**Last reviewed:** 2026-07-26

This document describes the implemented browser/WebView WebRTC protocol shared by hosted web thin, desktop Tauri thin, and Android thin. Python remains the reference peer for room/signaling/auth semantics; TypeScript implements the browser/WebView runtime and consumes Python-owned protocol fixtures.

## Runtime scope

- Runtime modes: `http-only`, `webrtc-only`, and `webrtc-preferred`.
- Signaling: MQTT over WebSocket/WSS in browser/WebView clients; MQTT topics carry room/app/channel presence, offers, answers, ICE candidates, and departure frames.
- Peer transport: one ordered `RTCDataChannel` labeled `aurora-rpc`.
- Application payloads: Aurora RPC calls/results/errors, streams, cancellation, manifests/auth frames, scoped subscribe/unsubscribe, events, fragmentation, and reconnect proof frames.
- Live-proven peer: Chromium browser SDK to Python Gateway RTC client/RPC handler with the Python HTTP API disabled.

## Reference implementations

| Surface | Path |
| --- | --- |
| Python contract descriptor | `app/services/gateway/webrtc/protocol_contract.py` |
| Python peer protocol/signaling/runtime | `app/services/gateway/webrtc/` |
| TypeScript contract descriptor | `packages/aurora-sdk/src/webrtc-protocol-contract.ts` |
| TypeScript runtime | `packages/aurora-sdk/src/webrtc/` |
| Shared WebView wrapper | `packages/aurora-ui/src/web-thin-runtime.ts` |
| Golden fixtures | `tests/fixtures/webrtc_web_thin_protocol_vectors.json` |
| Fixture generator | `scripts/generate_webrtc_protocol_fixtures.py` |

## Security contract

- Production app endpoints must be `https://`; production signaling must be `wss://`. Loopback `http://`/`ws://` is development-only and must be explicitly allowed.
- Room passwords derive signaling and data keys with deterministic Scrypt/HKDF-compatible behavior. Browser Scrypt runs off the UI thread.
- Signaling and optional application-layer DataChannel encryption use AES-GCM-compatible envelopes where configured; WebRTC DTLS still protects the DataChannel in transit.
- Pairing uses bilateral SAS v2 with SDP/channel binding and canonical JSON commitments.
- Reconnect uses the canonical `mesh_auth_proof_v1` HMAC proof bound to challenge, channel binding, stable peer IDs, signaling peer IDs, and room. Python, TypeScript, and native Android proof commands must stay fixture-compatible and must not emit legacy `proof_hmac_sha256`.
- Browser-hosted credentials are memory-only by default. Desktop/mobile native stores may persist scoped peer reconnect material, but profiles must not store raw invite secrets or bearer tokens.
- Revoked credentials fail closed; mutation retry logic must not replay uncertain in-flight mutations on a different transport. Current live proof covers a mutation started event followed by disconnect before response settlement with execution count 1, not a broad exactly-once guarantee.
- Event delivery is subscription/correlation scoped. Wildcard or wrong-correlation event leakage is a test failure. Scoped authorization stays on public production Auth/Gateway/DataChannel boundaries rather than private service calls.

## Dependency posture

- `packages/aurora-sdk/package.json` pins `mqtt@5.15.2` and `@noble/hashes@2.2.0`.
- WebRTC modules stay behind `@aurora/client/webrtc` or lazy WebView runtime imports. HTTP-only and desktop-local code must not import MQTT/WebRTC dependencies at SDK root.
- Native browser crypto/WebCrypto is used where available; test/runtime adapters inject deterministic crypto and fake peer connections.

## Verification

Protocol conformance and live interop commands:

```bash
uv run python scripts/generate_webrtc_protocol_fixtures.py --check
uv run pytest tests/unit/gateway/test_webrtc_web_thin_protocol_vectors.py
pnpm --dir packages/aurora-sdk test -- tests/webrtc-protocol-vectors.test.ts
pnpm --dir packages/aurora-sdk test -- tests/webrtc-runtime.test.ts
pnpm test:webrtc:interop
pnpm test:webrtc:turn
pnpm test:webrtc:browsers
```

Current checked reports prove direct, configured-STUN, and forced-TURN foreground interop in Chromium, Firefox, and Playwright WebKit. `pnpm test:webrtc:browsers` still records an explicit skip when an optional Playwright engine or its host runtime is unavailable; a skip is not compatibility proof. Required CI uses strict browser availability.
