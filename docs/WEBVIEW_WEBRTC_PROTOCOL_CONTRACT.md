# WebView WebRTC Thin-Shell Protocol Contract

**Status:** Current source of truth

**Last reviewed:** 2026-08-01

This document describes the implemented browser/WebView WebRTC protocol shared by hosted web thin, desktop Tauri thin, Android thin, and the iOS thin source path. Python remains the reference peer for room/signaling/auth semantics; TypeScript implements signaling, cryptography, pairing, reconnect, RPC, and transport policy and consumes Python-owned protocol fixtures. Linux desktop thin uses the same TypeScript protocol through a narrow native `RTCPeerConnection`/`RTCDataChannel` adapter when the system WebKitGTK build does not expose those DOM APIs.

## Runtime scope

- Runtime modes: `http-only`, `webrtc-only`, and `webrtc-preferred`.
- Signaling: MQTT over WebSocket/WSS in browser/WebView clients; MQTT topics carry room/app/channel presence, offers, answers, ICE candidates, and departure frames.
- Peer transport: one ordered `RTCDataChannel` labeled `aurora-rpc`.
- Application payloads: Aurora RPC calls/results/errors, streams, cancellation, manifests/auth frames, scoped subscribe/unsubscribe, events, fragmentation, and reconnect proof frames.
- Live-proven peers: Chromium, Firefox, and Playwright-WebKit browser SDKs to the Python Gateway RTC client/RPC handler across direct, configured-STUN, and forced-TURN lanes with the Python HTTP API disabled.

## Reference implementations

| Surface | Path |
| --- | --- |
| Python contract descriptor | `app/services/gateway/webrtc/protocol_contract.py` |
| Python peer protocol/signaling/runtime | `app/services/gateway/webrtc/` |
| TypeScript contract descriptor | `packages/aurora-sdk/src/webrtc-protocol-contract.ts` |
| TypeScript runtime | `packages/aurora-sdk/src/webrtc/` |
| Shared WebView wrapper | `packages/aurora-ui/src/web-thin-runtime.ts` |
| Linux Tauri peer-primitive adapter | `apps/aurora-tauri/src/native-webrtc.ts`, `apps/aurora-tauri/src-tauri/src/native_webrtc.rs` |
| Golden fixtures | `tests/fixtures/webrtc_web_thin_protocol_vectors.json` |
| Fixture generator | `scripts/generate_webrtc_protocol_fixtures.py` |

## Security contract

- Production app endpoints must be `https://`; production signaling must be `wss://`. Loopback `http://`/`ws://` is development-only and must be explicitly allowed.
- Room passwords derive signaling and data keys with deterministic Scrypt/HKDF-compatible behavior. Browser Scrypt uses `@noble/hashes` in a dedicated Worker, runs off the UI thread, zeroes transferred password/salt buffers, and is checked against Python-generated vectors.
- Signaling and optional application-layer DataChannel encryption use AES-GCM-compatible envelopes where configured; WebRTC DTLS still protects the DataChannel in transit.
- Pairing uses bilateral SAS v2 with SDP/channel binding and canonical JSON commitments.
- The SAS approval window is five minutes. A live client re-announces retained presence, deterministically renegotiates a fresh SDP-bound channel, and keeps retrying until explicitly disconnected. Work from a replaced DataChannel is generation-bound and cannot complete against the newer channel.
- Reconnect uses the canonical `mesh_auth_proof_v1` HMAC proof bound to challenge, channel binding, stable peer IDs, signaling peer IDs, and room. Python, TypeScript, and native Android proof commands must stay fixture-compatible and must not emit legacy `proof_hmac_sha256`.
- A direction that completed credential exchange survives transport loss: the holder proves that durable credential on the new channel, and the verifier returns `already_trusted` for that direction instead of creating another approval or rotating the credential. A click that did not complete credential delivery is not carried across a new SDP transcript without proof; a fresh SAS comparison remains required.
- Mesh-node approval presents only local features currently reported as available by the local feature-sharing catalog. The selected feature IDs are applied to the credential relationship; generic Gateway permissions are not offered as mobile-node resources.
- Hosted-browser reconnect material is encrypted before IndexedDB persistence with a non-extractable origin-scoped WebCrypto AES-GCM key. Unsupported or denied durable storage falls back to memory-only. Desktop/mobile native stores persist scoped reconnect material through OS credential stores. Profiles must not store raw invite secrets or bearer tokens.
- Revoked credentials fail closed; mutation retry logic must not replay uncertain in-flight mutations on a different transport. Current live proof covers a mutation started event followed by disconnect before response settlement with execution count 1, not a broad exactly-once guarantee.
- Event delivery is subscription/correlation scoped. Wildcard or wrong-correlation event leakage is a test failure. Scoped authorization stays on public production Auth/Gateway/DataChannel boundaries rather than private service calls.
- After authentication, a narrow redacted bootstrap-read allowlist may bypass mesh service-export projection so a thin client can discover its own identity, peer state, registry/services/health/topology, Mesh/WebRTC diagnostics, capability graph/catalog, and route explanation before choosing a shared service route. Normal exposure and RBAC checks still apply; for example `Auth.ListPendingPairings` still requires `Auth.manage`, `Gateway.GetCapabilityCatalog` still requires Gateway permission, and secret-bearing invite configuration is not in the bypass.
- Provider manifests are recipient-specific projections. A TypeScript peer host does not accept generated method calls until the remote structured ACK partitions every advertised service as compatible, incompatible, or unused; every required service must be compatible, and the ACK must match the active protocol/tier, projection digest, registry revision, export-policy revision, and auth-grant revision. A stale ACK may retransmit the same pending manifest only through the bounded retry path; it never activates the provider.
- A successful ACK starts an epoch-bound, monotonically revised provider lease. Renewal keeps the same epoch and raises the availability revision; `provider_unavailable` is the ordered tombstone for suspend, authority loss, or shutdown. Calls fail closed before handler dispatch while the provider is unacknowledged, unavailable, or revoked.
- Call, stream, and subscription work IDs share one active reservation space. A duplicate ID cannot overwrite another kind of work; it is rejected while the original reservation remains active. Revocation, cancellation, timeout, and disconnect close the original owner, and a call ID is not reusable until its handler or stream has actually returned.
- Fragmentation/backpressure and scoped-event extensions are activated only from the authenticated intersection of the local and remote `protocol_hello` capability sets. A local rollout gate therefore cannot be overridden by a remote advertisement.
- The application-layer E2EE rollout gate is an allowance, not a downgrade switch. A profile requiring E2EE fails closed when the gate is off; only a profile that explicitly permits DTLS-only JSON may use plaintext DataChannel frames.
- Encrypted frames may finish decoding asynchronously, but non-RPC application frames are handled in strict DataChannel arrival order. Identified RPC `call`, `result`, and `error` control frames are dispatched outside that application queue because bilateral pairing/reconnect operations can wait for reciprocal calls or replies on the same channel; queuing the reply behind the waiting operation would deadlock. This fast path does not permit ordinary auth, pairing, event, stream, or protocol frames to overtake one another.

## Rollout contract

Hosted web exposes `NEXT_PUBLIC_AURORA_WEBRTC_THIN_CLIENT`,
`NEXT_PUBLIC_AURORA_WEBRTC_SCOPED_SUBSCRIPTIONS`,
`NEXT_PUBLIC_AURORA_WEBRTC_FRAGMENTATION`, and
`NEXT_PUBLIC_AURORA_WEBRTC_APP_LAYER_E2EE`. Tauri/WebView builds expose the
matching `VITE_AURORA_WEBRTC_*` variables. Unset values preserve the current
enabled behavior.

Disabling the main thin-client gate closes/prevents WebRTC sessions without
touching saved credentials. `webrtc-preferred` may use its configured HTTP
transport; `webrtc-only` remains disabled and fail-closed; desktop-local is
unchanged. The Python Gateway separately exposes the temporary
`webrtc.legacy_event_broadcast` compatibility policy for non-sensitive
unscoped events. That policy never enables sensitive or scoped-only
broadcasts.

## Dependency posture

- `packages/aurora-sdk/package.json` pins `mqtt@5.15.2` and `@noble/hashes@2.2.0`.
- WebRTC modules stay behind `@aurora/client/webrtc` or lazy WebView runtime imports. HTTP-only and desktop-local code must not import MQTT/WebRTC dependencies at SDK root.
- Native browser crypto/WebCrypto is used where available; test/runtime adapters inject deterministic crypto and fake peer connections.
- The Linux Tauri fallback pins `webrtc@0.11.0` only under the Linux Cargo target. Its Rust DTLS/ICE/SCTP implementation is linked into the application binary; it does not add a GStreamer or system WebRTC runtime dependency. macOS/iOS use OS WKWebView, Android uses System WebView, and Windows installers provision WebView2.
- The native bridge is deliberately not a second Aurora protocol implementation. It owns offer/answer descriptions, ICE candidates, connection state, one ordered DataChannel, backpressure state, and redacted stats only; MQTT signaling, SAS, application-layer encryption, reconnect proof, route authorization, and RPC framing remain in TypeScript.
- Authenticated catalog/registry/graph replies can exceed one megabyte and include generated permission arrays larger than 256 entries. The bounded parser therefore allows arrays up to 4096 entries while retaining the negotiated 8 MiB logical-message cap; larger arrays still fail closed.
- Linux native IPC uses a 90-second request budget and service-routing bootstrap uses 60 seconds so fragmented capability snapshots can complete without weakening protocol size limits or retry semantics.

## Verification

Protocol conformance and live interop commands:

```bash
uv run python scripts/generate_webrtc_protocol_fixtures.py --check
uv run pytest tests/unit/gateway/test_webrtc_web_thin_protocol_vectors.py
pnpm --dir packages/aurora-sdk test -- tests/webrtc-protocol-vectors.test.ts
pnpm --dir packages/aurora-sdk test -- tests/webrtc-runtime.test.ts
pnpm --filter @aurora/tauri-ui exec vitest run src/native-webrtc.test.ts
cargo test --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml native_webrtc
pnpm test:web-thin:live
pnpm test:webrtc:interop
pnpm test:webrtc:turn
pnpm test:webrtc:browsers
pnpm --filter @aurora/tauri-ui android:webrtc:interop
pnpm --filter @aurora/tauri-ui ios:webrtc:interop
```

The required WebRTC interop workflow proves direct, configured-STUN, and
forced-TURN foreground interop in Chromium, Firefox, and Playwright WebKit
when it passes. Every lane also proves deterministic negotiation direction, manifest exchange,
structured error parity, fragmented 512 KiB request/response transfer,
stream completion, and cancellation observed by the Python peer.
The Android and iOS commands apply that same external-Python pairing contract
to mobile surfaces in their existing platform jobs: packaged Android System
WebView plus Android Chrome, and iOS MobileSafari plus packaged Tauri
WKWebView. Per-run reports are generated in ignored local paths and retained
through CI artifacts; source wiring or a Linux skip is not runtime proof.
`pnpm test:webrtc:browsers` records an explicit skip when an optional
Playwright engine or its host runtime is unavailable; a skip is not
compatibility proof. Required CI uses strict browser availability.
