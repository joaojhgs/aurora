# V868 selected mesh-route observation preparation

This is a private, inert harness hook; it has not been installed into a running Gateway and no RTC call was made. It wraps only the existing `PeerBridge.call` method when the private bootstrap supplies the exact typed TTS topic. It samples the exact stable peer before and after that call, preserves the original call/result/exception, and emits the correlation, caller PID/monotonic interval, hashed peer/session/connection identities, nominated candidate types/protocols, and a finite observation status. It never records addresses, ports, foundations, SDP, payloads, or exception text. Observation failures do not affect the request.

The Python route is grounded in the production caller: `app/services/gateway/mesh/peer_bridge.py` defines the peer-targeted `call` boundary, and `app/services/gateway/webrtc/rtc_client.py` resolves a stable peer to its session and that session's `RTCPeerConnection`. The pinned environment is `aiortc 1.14.0` and `aioice 0.10.2`. In that version, `RTCPeerConnection.getStats()` reports RTP stats and does not expose the selected ICE pair. The hook therefore uses the pinned implementation's read-only path from the peer connection's ICE transports to each ICE connection's `_nominated` map; only nominated, succeeded pairs with allowlisted candidate types and protocols are classified. A relay candidate yields `relay`; two known non-relay candidate types yield `direct`; absent/invalid pair data remains `unknown` via a finite status. This private-internals dependency is version-specific and must fail closed as unavailable if the admitted runtime versions differ.

The SDK also has a separate public per-peer `getPeerSelectedCandidatePairEvidence` path (`packages/aurora-sdk/src/webrtc/runtime.ts` and `peer-session.ts`) that selects the transport's nominated pair and redacts addresses. Native Tauri has a redacted stats command as well (`apps/aurora-tauri/src-tauri/src/native_webrtc.rs`). Those are useful UI/native observations, but the Python hook is the one aligned to the actual Gateway `PeerBridge.call` that carries remote TTS and its request correlation. Cross-process stage timings must remain in their own monotonic clock domains; join by the real correlation only, never subtract their timestamps.

## Provenance and validation

| File | SHA-256 |
|---|---|
| `mesh_route_observer.py` | `2c23fd2bc69b00b746c2c5dc28c1d2b77428016314045363dceea5fe9ee5cdbb` |
| `app/services/gateway/mesh/peer_bridge.py` | `3a0748a6fd8093f4b8f616a578af94f8a86ae0700cd0099ab5847f9235f2330d` |
| `app/services/gateway/webrtc/rtc_client.py` | `d3a5ee5e02c976839d221ba7a4996a30f074b42a53fc25530b987879e7dc58b7` |
| installed `aiortc/rtcpeerconnection.py` | `c75eb9037a62380ab08670deae32a51f2c15b8d8145a80a8e72e9d4ea1ddf3bd` |
| installed `aiortc/rtcicetransport.py` | `810c0f3eb4b09b5eebe7c6ac48d7b8296762fc9c977ebf8bc8d751be0d922422` |
| installed `aioice/ice.py` | `4f2b060e541236b53614e7702a09eb363f9897d5aed3a8a40267d9891f8c2b7e` |
| `aiortc-1.14.0.dist-info/METADATA` | `3c94d706a75f8bae164d894b87b78f2546fd2766b02dbc955f1d21ac100aaa9f` |
| `aioice-0.10.2.dist-info/METADATA` | `aa81c58fc9c45df33ccf1fa5d6f11dd73f3e3a06ff4a83877fc59664e1a769a2` |
| SDK `peer-session.ts` | `5f9d08a04225c060b8794d1db1051452493439225fe6c504b67c22e04ce2012d` |
| SDK `runtime.ts` | `849a820c8f94261996307d1e06b0dc421e4a4f13f70a4d38e26c002a338dbc15` |
| SDK `peer-registry.ts` | `13bbb7e0b29ba64d4327dd60e9c744987faa9f8885417485505b4e1e674606c6` |
| `packages/aurora-ui/src/web-thin-runtime.ts` | `8034f4f1e7b1545851fe1c5f14bc8aac3f9e6ad90a389ce7962d41dc356d667d` |
| native `native_webrtc.rs` | `76e1bb6dd911f3a770b4870af46a29c6096d2f81d471c5f8610aa1ad0d1360c0` |

The hook passed a standard-library AST parse (`AST_OK`, 9,275 bytes). No tests, imports of Aurora/RTC packages, runtime, model, device, network, or session were executed. Root still needs to integrate it into the private K1 mesh harness, pin the installed versions at admission, and validate it against the independently collected 15 warmup records before any measured case. It is not runtime evidence and does not establish direct-versus-relay for a live peer.
