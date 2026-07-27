# WebView WebRTC thin-shell implementation plan

- **Created:** 2026-07-23
- **Status:** Implementation-ready planning artifact; no implementation in this pass
- **Scope:** Hosted web, desktop Tauri thin, Android Tauri thin, and iOS Tauri thin direct-peer operation through one browser/WebView WebRTC implementation
- **Primary decision:** Implement Aurora's peer transport in TypeScript under `packages/aurora-sdk`; do not duplicate it in Rust or embed the Python runtime
- **Roadmap:** `docs/UI_CLIENT_SURFACE_ROADMAP.md`
- **Current state:** `docs/UI_CLIENT_SURFACE_STATUS.md`

## 1. Outcome and stop condition

Deliver a shared WebView peer runtime that lets an Aurora thin shell pair with and call an authorized Python Aurora peer over the existing MQTT-signaled WebRTC protocol while that peer's FastAPI listener is disabled. The UI must continue to call `AuroraClient`, never raw WebRTC/MQTT APIs.

The implementation is complete only when:

1. one browser implementation works in hosted web, desktop Tauri WebView, Android WebView, and WKWebView foreground contexts;
2. it interoperates byte-for-byte with Python signaling, cryptography, pairing, reconnect, RPC, streaming, cancellation, and scoped event behavior;
3. assistant text streaming, focused push-to-talk, cancellation, and client TTS playback work through the peer path;
4. production packages and hosted builds preserve auth, redaction, CSP, secure-storage, and permission boundaries;
5. the no-sidecar desktop artifact contains no Python executable/runtime;
6. direct, STUN, and forced TURN-relay test lanes pass; and
7. unsupported background/native capabilities remain explicit rather than inferred.

## 2. Requirements summary

### Functional requirements

- Support three connection policies: `http-only`, `webrtc-only`, and `webrtc-preferred`.
- Reuse `MeshP2PTransport` and implement its `MeshPeerBridge` seam (`packages/aurora-sdk/src/mesh.ts:84-119`, `packages/aurora-sdk/src/mesh.ts:121-244`).
- Match Python's separate signaling and stable mesh identities (`app/services/gateway/webrtc/rtc_client.py:183-190`).
- Match MQTT topic, presence, QoS, reconnect, and WSS behavior (`app/services/gateway/webrtc/signaling/mqtt_client.py:51-53`, `app/services/gateway/webrtc/signaling/mqtt_client.py:89-183`).
- Match Scrypt/HKDF/AES-GCM behavior (`app/services/gateway/utils/crypto.py:35-78`).
- Match pairing protocol v2, exact SDP channel binding, canonical JSON, commitments, and eight-digit SAS (`app/services/gateway/webrtc/pairing_sas.py:19-28`, `app/services/gateway/webrtc/pairing_sas.py:37-43`, `app/services/gateway/webrtc/pairing_sas.py:68-101`, `app/services/gateway/webrtc/pairing_sas.py:178-219`).
- Match the single in-band `aurora-rpc` channel and offerer/answerer ownership (`app/services/gateway/webrtc/rtc_client.py:3742-3758`, `app/services/gateway/webrtc/rtc_client.py:4249-4253`).
- Match call/result/error/chunk/eof/cancel/event semantics (`app/services/gateway/mesh/peer_bridge.py:61-91`, `app/services/gateway/mesh/peer_bridge.py:233-302`, `app/services/gateway/mesh/peer_bridge.py:419-455`, `app/services/gateway/webrtc/rpc.py:236-251`).
- Add capability-negotiated scoped subscriptions and fragmentation without breaking existing Python peers.
- Preserve focused WebView microphone capture already present in the UI (`packages/aurora-ui/src/assistant-view.tsx:1810-1902`, `packages/aurora-ui/src/assistant-view.tsx:1949-2031`).
- Make endpoint/invite selection change the active runtime; the current onboarding button only changes local UI state (`packages/aurora-ui/src/onboarding-view.tsx:335-350`).
- Preserve the centralized platform and voice contract (`packages/aurora-ui/src/platform-surface.ts:61-109`, `packages/aurora-ui/src/platform-surface.ts:130-170`).

### Security requirements

- Production hosted pages use HTTPS; production signaling uses `wss:`. Loopback `http:`/`ws:` is development-only.
- Encrypted signaling is mandatory for production profiles. Optional application-layer DataChannel E2EE must interoperate with Python's binary AES-GCM mode (`app/services/gateway/webrtc/rtc_client.py:1061-1119`). WebRTC DTLS remains required regardless.
- Room discovery is not authorization. Invites pin the expected stable peer ID; pairing/auth must finish before service calls.
- Thin shells advertise a consumer-only/minimal manifest and reject inbound service calls unless a future explicit provider mode is enabled.
- Browser secrets are memory-only by default. Tauri/mobile use OS credential stores; proof operations should occur in the native layer where practical.
- Logs, errors, support bundles, analytics, and URLs must not expose long-lived tokens, room passwords, pairing nonces, raw audio, SDP, ICE credentials, or unredacted service payloads.
- Event subscriptions are exact-topic, permission-checked, correlation-scoped where applicable, bounded, expiring, and removed on disconnect.
- No automatic replay of an uncertain in-flight mutation during transport fallback.
- Malformed/oversized signaling, fragments, RPC frames, and subscription requests fail closed with bounded memory and redacted diagnostics.

### Platform requirements

- Browser/WebView transport code has no direct Tauri, Kotlin, or Swift imports.
- SSR/server imports do not touch `window`, `navigator`, `RTCPeerConnection`, Web Crypto, Worker, or MQTT browser globals.
- Desktop Tauri allows only validated HTTPS/WSS destinations in production and provides secure peer-credential operations.
- Android and iOS v1 support foreground peer sessions only. Background claims require separate native evidence.
- Microphone permission is needed only for voice capture, not for data-only WebRTC connection.

### Non-goals for the first release

- No Rust WebRTC stack.
- No PyO3/libpython embedding and no attempt to turn PyInstaller output into an in-process Rust library.
- No WebRTC audio/video media tracks; audio stays on typed RPC/event paths initially.
- No durable background WebRTC session in a normal browser or mobile WebView.
- No full local Python or desktop-model runtime on mobile.
- No automatic multi-peer service-provider UI in v1; internals remain keyed by peer ID so it can be added later.
- No transparent retry of arbitrary calls across HTTP and WebRTC.

## 3. Current architecture anchors

| Anchor | Current evidence | Planning consequence |
| --- | --- | --- |
| Shared transport seam | `MeshPeerBridge` and `MeshP2PTransport` already normalize peer calls/events (`packages/aurora-sdk/src/mesh.ts:84-244`). | Implement a bridge; do not create a second Aurora client API. |
| UI boundary | Production UI is SDK-first; Tauri regression tests scan for transport bypasses (`apps/aurora-tauri/src/ui-service-boundary.test.ts:101-120`). | UI receives only typed connection state/actions. |
| Rust boundary | Tests enforce process supervision/Gateway proxy and reject PyO3/service logic (`apps/aurora-tauri/src/ui-service-boundary.test.ts:122-143`). | Keep Rust native work narrow and explicit. |
| HTTP thin selector | Tauri chooses HTTP from build-time URL/token (`apps/aurora-tauri/src/aurora-client.ts:68-135`). | Introduce a runtime connection profile and live auth-token source. |
| Web HTTP auth | Browser HTTP transport uses `client.auth.bearerToken()` dynamically (`apps/aurora-web/app/aurora-client.ts:54-73`). | Preserve this behavior for HTTP and peer runtime reconstruction. |
| Surface truth | Surface and voice ownership are centralized (`packages/aurora-ui/src/platform-surface.ts:1-9`, `packages/aurora-ui/src/platform-surface.ts:61-109`). | Add transport capabilities there first; do not branch ad hoc in screens. |
| Independent Python RTC | Gateway starts HTTP and WebRTC separately; HTTP can return early while RTC starts (`app/services/gateway/service.py:1229-1231`, `app/services/gateway/service.py:3225-3232`, `app/services/gateway/service.py:3509-3572`). | Interop acceptance must run with `api.enabled=false`. |
| Event broadcast | MeshBus currently loops over all negotiated peers for `mesh=True` events (`app/messaging/mesh_bus.py:258-270`). | Add peer-scoped subscription filtering before forwarding sensitive streams. |
| Assistant text | Orchestrator stream events can be mesh-forwarded (`app/services/orchestrator/service.py:1795-1826`). | Text streaming is compatible after scoped subscriptions. |
| Assistant audio gap | TTS chunks explicitly publish with `mesh=False` (`app/services/tts/service.py:837-845`). | Targeted peer TTS delivery is a release blocker. |
| Package mismatch | `build:bundle:thin` still stages a sidecar (`apps/aurora-tauri/package.json:9-18`). | Add and inspect a genuinely no-sidecar artifact. |
| Network policy | Tauri CSP currently allows only self/loopback HTTP and WS (`apps/aurora-tauri/src-tauri/tauri.conf.json:23-26`). | Production remote HTTPS/WSS needs an explicit CSP and allowlist design. |

## 4. Architecture decision

### 4.1 Selected architecture

```text
App runtime factory
  -> ConnectionProfileStore
  -> WebRtcPeerRuntime (TypeScript, browser-only lazy import)
       -> WebRtcMeshPeerBridge implements MeshPeerBridge
       -> MeshP2PTransport
       -> AuroraClient
  -> PeerConnectionController (typed status/pair/disconnect/diagnostics)
  -> optional NativePeerCredentialAdapter

WebRtcPeerRuntime
  -> Crypto worker (Scrypt) + Web Crypto (HKDF/AES-GCM/HMAC/SHA-256)
  -> MQTT-over-WSS signaling adapter
  -> RTCPeerConnection session manager
  -> one reliable ordered `aurora-rpc` RTCDataChannel
  -> auth/pairing/reconnect state machine
  -> RPC multiplexer + stream/cancel/event subscriptions
  -> fragmentation/backpressure layer
```

`WebRtcMeshPeerBridge` owns peer wire behavior. `MeshP2PTransport` continues to own Aurora request/event normalization and route selection. A separate typed `PeerConnectionController` exposes lifecycle evidence to app factories and UI; raw MQTT clients, peer connections, channels, keys, SDP, and credentials are never placed in React state.

### 4.2 Runtime profile

Define a versioned, validated connection profile in the SDK/app boundary:

```ts
type AuroraConnectionMode = 'http-only' | 'webrtc-only' | 'webrtc-preferred'

interface WebRtcPeerConnectionProfile {
  version: 1
  appId: string
  room: string
  brokers: string[]              // production: wss only
  expectedPeerId: string
  expectedNodeName?: string
  signalingEncryption: true
  appLayerE2ee: boolean
  stunUrls: string[]
  turn?: { urls: string[]; username?: string; credentialRef?: string }
  inviteExpiresAt?: string
}
```

Do not persist `roomPassword`, pairing code, peer token, or TURN password in this plain profile. Store secret values in the selected credential adapter and reference them by an opaque ID. Browser mode keeps the adapter in memory.

### 4.3 Connection policies

- **`http-only`:** existing Gateway path; no signaling client created.
- **`webrtc-only`:** fail visibly if the peer is not connected and authorized; never silently call HTTP.
- **`webrtc-preferred`:** choose WebRTC for a new call when connected, authorized, and capable; otherwise choose HTTP if configured. If a call has been sent, channel loss resolves that call as `transport_loss`; it is never silently resent. A user or higher-level idempotence-aware workflow may retry explicitly.

An eventual safe-read retry policy may use registry method metadata, but it is not part of v1.

### 4.4 Why not Rust or embedded Python

- Browser/WebView WebRTC is available to every target thin client; Rust WebRTC would benefit only Tauri and require a second event/stream bridge.
- Current Rust dependencies contain no WebRTC stack (`apps/aurora-tauri/src-tauri/Cargo.toml:20-38`) and current tests intentionally forbid embedding Python business logic (`apps/aurora-tauri/src/ui-service-boundary.test.ts:122-143`).
- PyInstaller produces an external executable, not a callable library. PyO3 embedding would still ship CPython plus native Python wheels, preserve GIL/interpreter lifecycle complexity, and provide no shared hosted-web solution.
- Desktop local remains an external supervised Python node. Thin shells eliminate Python by reaching an existing peer directly.

## 5. Protocol compatibility contract

Before feature work, turn the current Python behavior into a versioned interoperability contract.

### 5.1 Golden fixture set

Add a deterministic fixture generator such as `scripts/generate_webrtc_protocol_fixtures.py` and commit output under `packages/aurora-sdk/tests/fixtures/webrtc-protocol-v2.json`. Fixtures contain only synthetic test material and cover:

- base64url encoding without padding;
- `SHA256(app_id + "|" + room)` salt;
- Scrypt `N=2^16, r=8, p=1, length=32`;
- HKDF info strings for signaling/data keys;
- AES-GCM fixed-nonce encrypt/decrypt vectors using `nonce || ciphertext || tag`;
- MQTT topic paths and presence/departure envelopes;
- canonical JSON and exact offer/answer channel binding;
- pairing identities, commitments, transcript hash, session ID, and SAS;
- reconnect challenge/proof vectors;
- offer/answer/candidate envelopes;
- auth/reauth/manifest frames;
- call/result/error/chunk/eof/cancel/event frames;
- subscription-v2 frames and acknowledgements;
- fragmentation frames and reassembly hashes.

Add a check patterned after `scripts/check_sdk_backend_conformance.py` so CI fails when generated Python fixtures and committed TypeScript fixtures drift.

### 5.2 Version/capability negotiation

Extend presence and/or the first DataChannel hello/manifest exchange with additive fields:

```json
{
  "protocol_versions": [1, 2],
  "capabilities": [
    "scoped_event_subscriptions_v1",
    "fragmentation_v1",
    "consumer_only_v1"
  ]
}
```

Rules:

- Ignore unknown additive fields.
- Select the highest common version/capability independently; do not assume protocol v2 means every extension.
- Preserve current Python-to-Python v1 behavior while migration runs.
- Require `scoped_event_subscriptions_v1` and `fragmentation_v1` before a thin client is declared release-ready.
- Record only capability names/versions in diagnostics; no secrets or raw SDP.

### 5.3 Signaling compatibility

Implement the current MQTT contract:

- topic base `{root}/{app_id}/{room}/{channel}` with target suffix for offer/answer/candidate (`app/services/gateway/webrtc/signaling/mqtt_client.py:51-53`);
- retained QoS 1 presence and authenticated departure; QoS 0 offer/answer/candidate/broadcast (`app/services/gateway/webrtc/signaling/mqtt_client.py:55-118`);
- browser brokers restricted to `ws:`/`wss:`, production to `wss:`;
- ordered broker failover and bounded reconnect with exponential backoff plus jitter;
- restore subscriptions and retained live presence after reconnect;
- random signaling ID per session and separate stable identity;
- lower signaling ID creates the offer to avoid glare (`app/services/gateway/webrtc/rtc_client.py:2853-2935`);
- exact offer/answer SDP bytes retained for pairing channel binding.

Use MQTT.js after a dependency/security/license/bundle review. Browser MQTT supports WebSocket transports, which matches the existing WSS broker configuration (`app/services/gateway/config.py:179-186`). Keep the import inside the browser-only runtime.

### 5.4 Cryptography compatibility

Define a `PeerCryptoProvider` interface and ship a browser implementation:

- run Scrypt asynchronously in a dedicated Web Worker so `N=2^16` does not block rendering;
- use Web Crypto for SHA-256, HKDF, HMAC, AES-GCM, and random bytes;
- use constant-time byte comparison for commitments/proofs where JS permits;
- zero/replace JS buffers after use on a best-effort basis and never stringify secrets;
- support both plaintext DataChannel JSON and Python-compatible binary app-layer E2EE mode;
- reject plaintext when app-layer E2EE is negotiated as required, matching Python's fail-closed behavior (`app/services/gateway/webrtc/rtc_client.py:1080-1106`).

Web Crypto does not provide Scrypt, so evaluate a small audited browser implementation (for example, a reviewed `scryptAsync` implementation) rather than hand-writing the primitive. The SDK currently has no runtime dependencies (`packages/aurora-sdk/package.json`); any addition requires license, maintenance, bundle-size, CSP/worker, and performance evidence.

### 5.5 DataChannel and session state machine

Implement explicit states rather than boolean flags:

```text
idle
 -> deriving-keys
 -> signaling-connecting
 -> discovering-peer
 -> negotiating
 -> channel-open
 -> pairing-required | reconnect-authenticating
 -> awaiting-sas-confirmation
 -> authorized
 -> reconnecting
 -> closed | failed
```

Requirements:

- one reliable ordered in-band channel labeled `aurora-rpc`;
- only the SDP offerer calls `createDataChannel`; the answerer accepts that label;
- exact peer/session object ownership and deterministic cleanup of listeners, timers, Workers, MQTT, pending RPCs, subscription iterators, and channels;
- one active invited provider in v1, but maps keyed by signaling/stable peer ID internally;
- reject unsolicited peers that do not match `expectedPeerId` before pairing UI is shown;
- bound negotiation and auth timers to Python defaults/config values;
- reconnect only after transient failure, never after explicit disconnect, denial, expired invite, or identity mismatch;
- use jittered capped reconnect and surface the reason/action to UI.

### 5.6 RPC, streaming, and cancellation

Implement a request multiplexer compatible with Python:

- `call` contains `id`, `correlation_id`, `method`, `params`, and identity/audit metadata (`app/services/gateway/mesh/peer_bridge.py:61-91`);
- one pending map keyed by stable peer and request ID;
- results/errors resolve exactly once;
- chunks are exposed as bounded async iterables;
- iterator cancellation, abort signals, timeouts, and disconnect send one best-effort `cancel` then release local resources (`app/services/gateway/mesh/peer_bridge.py:233-302`);
- late or duplicate frames are ignored and counted, not re-delivered;
- response envelopes retain method, bus topic, peer, target peer, transport, correlation, permission, and redaction evidence expected by `MeshP2PTransport`.

A thin consumer rejects incoming `call` frames by default. It may accept auth, pairing, reconnect, capability, subscription acknowledgement, result/stream, event, ping/pong, and fragmentation control frames only.

### 5.7 Fragmentation and backpressure

The current push-to-talk path can produce hundreds of kilobytes of base64 PCM (`packages/aurora-ui/src/assistant-view.tsx:2005-2031`), so relying on one DataChannel message is not portable.

Add capability-negotiated logical-message fragmentation on both Python and TypeScript sides:

- default fragment payload no larger than 16 KiB in tests; select a runtime size below the negotiated SCTP maximum;
- each fragment includes protocol name, logical message ID, sequence, total count/length, and final SHA-256;
- apply optional app-layer E2EE to each fragment frame, then reassemble only after every fragment authenticates;
- cap one logical message at 8 MiB, one peer's aggregate reassembly at 16 MiB, and incomplete-message age at 30 seconds initially;
- reject duplicate/conflicting/out-of-range fragments;
- bound the send queue and use `bufferedAmount`/`bufferedamountlow` before continuing;
- abort pending sends immediately when the channel closes;
- do not compress secret-bearing frames.

The limits are initial safety constants, exported for configuration/tests, and must be revised only with interoperability and memory evidence.

### 5.8 Scoped event subscriptions and TTS

Current mesh event forwarding broadcasts `mesh=True` events to all negotiated peers (`app/messaging/mesh_bus.py:258-270`) and has no subscription wire frame (`app/services/gateway/webrtc/rpc.py:236-251`). Fix this before enabling sensitive UI streams.

Add capability-negotiated frames:

```json
{"type":"subscribe","id":"...","topics":["Orchestrator.Response"],"correlation_ids":["..."],"expires_in_ms":120000}
{"type":"subscribed","id":"...","accepted_topics":["Orchestrator.Response"],"expires_at":"..."}
{"type":"unsubscribe","id":"..."}
```

Python-side behavior:

- add a per-authenticated-stable-peer `MeshEventSubscriptionRegistry` under `app/services/gateway/webrtc/`;
- validate exact typed event topics against the registry/contracts and the authenticated peer's effective permissions;
- prohibit wildcard topics in v1;
- cap topics/subscriptions per peer and expire them;
- make MeshBus/PeerBridge select interested peers by topic and optional correlation ID before serialization/sending;
- preserve legacy Python peer broadcast only for peers without the scoped-subscription capability and behind an explicit compatibility policy;
- require explicit scoped subscription for sensitive payload classes such as audio regardless of legacy mode;
- remove all subscriptions on channel/auth loss.

TypeScript behavior:

- `WebRtcMeshPeerBridge.subscribe()` sends `subscribe`, waits for acknowledgement, yields only matching frames, and always sends `unsubscribe` on iterator return/abort;
- subscribe before the assistant request, matching the existing SDK assistant sequence;
- apply local validation as defense in depth but never rely on local filtering as authorization.

TTS solution:

- after peer filtering exists, make `TTS.AudioChunk` eligible for mesh delivery only when its correlation/stream ID matches an active authorized peer subscription;
- do not change it into a broadcast. Today it is deliberately local-only (`app/services/tts/service.py:837-845`);
- propagate the originating stable peer/correlation through Orchestrator -> TTS stream state as typed metadata if correlation alone cannot uniquely target the subscriber;
- preserve `TTSAudioChunkEvent` ordering/final markers and existing client playback semantics;
- retain `TTS.Synthesize` whole-audio response (`app/shared/contracts/models/tts.py:47-66`) as an explicit fallback, not the primary streamed assistant path.

## 6. SDK and application API shape

### 6.1 Proposed SDK modules

Prefer a cohesive folder rather than one oversized file:

```text
packages/aurora-sdk/src/webrtc/
  types.ts
  protocol.ts
  crypto.ts
  crypto-worker.ts
  signaling-mqtt.ts
  fragmentation.ts
  rpc-multiplexer.ts
  subscriptions.ts
  peer-session.ts
  bridge.ts
  runtime.ts
```

Exports from `packages/aurora-sdk/src/index.ts` should be typed factories/interfaces. Do not export internal key material, raw peer connection/channel objects, or MQTT types.

Proposed public surface:

```ts
interface PeerConnectionController {
  snapshot(): PeerConnectionSnapshot
  subscribe(listener: (snapshot: PeerConnectionSnapshot) => void): () => void
  connect(profile: WebRtcPeerConnectionProfile): Promise<void>
  confirmPairing(sessionId: string): Promise<void>
  rejectPairing(sessionId: string): Promise<void>
  disconnect(reason?: string): Promise<void>
}

interface WebRtcAuroraRuntime {
  client: AuroraClient
  peer: PeerConnectionController
  close(): Promise<void>
}
```

`PeerConnectionSnapshot` contains state, expected/connected stable peer ID, node name, selected signaling broker origin, ICE path category (`host`/`srflx`/`relay`), protocol capabilities, reconnect count, last redacted error, and timestamps. It contains no SDP, candidate address, password, token, nonce, or raw service payload.

### 6.2 Credential adapters

Define an injected interface:

```ts
interface PeerCredentialStore {
  getRoomSecret(ref: string): Promise<Uint8Array | null>
  putReconnectCredential(peerId: string, token: Uint8Array): Promise<void>
  createReconnectProof(peerId: string, challenge: ReconnectChallenge): Promise<Uint8Array>
  removePeer(peerId: string): Promise<void>
}
```

Implementations:

- `MemoryPeerCredentialStore` for hosted web; cleared on refresh/close and never uses web storage;
- desktop Tauri adapter using OS keychain-backed commands;
- Android Keystore and iOS Keychain adapters through existing native plugin boundaries;
- test-only deterministic store.

The JS runtime may receive a newly issued token during pairing, but it should immediately hand it to the adapter and discard local references. Reconnect should request a proof, not retrieve the long-lived token, on native surfaces.

### 6.3 Runtime configuration and onboarding

Replace build-time-only selection with a runtime connection profile store:

- app factories read a validated stored profile before constructing the client;
- onboarding validates and stages an HTTPS Gateway URL or mesh invite, then explicitly activates it;
- switching profiles closes old transports, cancels streams, clears unsafe auth state, and constructs a new runtime;
- plain endpoints and non-secret peer metadata may be persisted; secrets go only to the credential adapter;
- build-time environment variables remain bootstrap defaults for managed deployments, not the only configuration path.

Extend `getAuroraSurfaceProfile()` with capability flags such as `supportsHttpTransport`, `supportsWebRtcTransport`, `supportsNativeCredentialStore`, and `supportsDurableBackgroundVoice` before consuming them in onboarding/settings. Do not add transport-specific conditionals across pages.

## 7. Implementation sequence

Each phase is independently reviewable and must leave the existing HTTP/local paths passing.

### Phase 0 — Baseline and regression locks

**Files:** existing protocol tests under `tests/`, SDK tests under `packages/aurora-sdk/tests/`, Tauri boundary tests, new fixture generator/check.

1. Record current Python protocol behavior in golden fixtures.
2. Add Python tests for exact signaling topics, KDF/AEAD vectors, pairing transcript, reconnect proof, and wire envelopes.
3. Add TypeScript tests that consume the same fixture before implementation; mark only the not-yet-implemented execution portions as expected failures in a dedicated branch, never the main branch.
4. Add/retain tests proving UI files cannot import MQTT/WebRTC internals and Rust cannot embed Python service logic.
5. Add a package-content test specification for future no-sidecar artifacts.

**Gate:** fixtures are deterministic, contain no production material, and CI detects drift.

### Phase 1 — Make HTTP thin mode production-correct

**Files:** `apps/aurora-tauri/src/aurora-client.ts`, `apps/aurora-web/app/aurora-client.ts`, onboarding/runtime provider files, Tauri security/config, associated tests/docs.

1. Add runtime connection profile loading/switching.
2. Change Tauri HTTP bearer lookup to the live `AuthSession` closure, matching browser behavior (`apps/aurora-web/app/aurora-client.ts:54-73`).
3. Validate endpoint scheme/origin, persist only non-secret data, and close old runtime on switch.
4. Split managed bootstrap defaults from user-selected runtime config.
5. Add a real remote/no-sidecar Tauri bundle config and script; keep current profiled local builds backward compatible.
6. Add artifact inspection to assert no `aurora-sidecar`, CPython, `.py`, or Python shared library in the remote bundle.

**Gate:** desktop thin HTTP works after login without rebuild and its artifact is Python-free.

### Phase 2 — Protocol types and crypto worker

**Files:** new SDK WebRTC protocol/crypto modules, package dependencies, fixture tests, worker bundler tests.

1. Define discriminated unions and strict parsers for every accepted signaling/DataChannel frame.
2. Reject prototype-bearing/non-object/unknown required fields and cap string/array sizes before allocation.
3. Implement base64url, canonical JSON, SHA-256, HKDF, HMAC, AES-GCM, random bytes, and constant-time comparison.
4. Integrate reviewed asynchronous Scrypt inside a Worker.
5. Prove both E2EE-off text frames and E2EE-on binary frames against Python fixtures.
6. Verify worker/crypto imports are SSR-safe and supported by Vite/Next/Tauri builds.

**Gate:** all crypto/pairing fixture vectors match Python exactly and the UI thread remains responsive during key derivation.

### Phase 3 — MQTT/WSS signaling

**Files:** `signaling-mqtt.ts`, tests, app CSP/origin policy helpers.

1. Implement exact topics, QoS, retained presence/departure, broker failover, subscribe restoration, and close behavior.
2. Enforce WSS in production and sanitize broker URLs in diagnostics.
3. Decrypt and validate presence before acting.
4. Pin the expected stable peer and ignore unrelated retained room peers.
5. Add local broker tests over WSS plus reconnect and retained-message cases.

**Gate:** the TypeScript peer discovers a Python peer and exchanges encrypted offer/answer/candidates without using HTTP.

### Phase 4 — RTCPeerConnection session and DataChannel

**Files:** `peer-session.ts`, browser harness, Python compatibility tests.

1. Implement offer tie-break, ICE config, exact SDP retention, candidate exchange, one `aurora-rpc` channel, timeouts, and cleanup.
2. Add connection-state and ICE-path diagnostics without candidate addresses.
3. Implement application E2EE negotiation and frame encode/decode.
4. Add deterministic reconnect suppression after explicit close and identity/pairing denial.
5. Test initiator and answerer roles in both directions.

**Gate:** the browser and Python reach `channel-open` through direct/STUN and forced TURN paths.

### Phase 5 — Pairing, authorization, reconnect, and credentials

**Files:** `peer-session.ts`, pairing protocol module, credential adapters, Rust/native narrow commands, Python interop tests.

1. Implement pairing v2 commit/reveal and exact SAS.
2. Require explicit local confirmation and matching remote terminal state before accepting authorization.
3. Exchange/store the issued peer credential with strict timeouts and identity binding.
4. Implement reconnect challenge/proof with native proof adapters on Tauri/mobile and memory-only browser behavior.
5. Reject identity changes, reused/expired invites, invalid commitments, proof replays, and unsolicited peers.
6. Add remove/revoke flows that clear native storage and active sessions.

**Gate:** first pairing and later reconnect both work with the Python peer; token bytes are absent from logs and durable browser storage.

### Phase 6 — RPC bridge, streaming, fragmentation, and cancellation

**Files:** `bridge.ts`, `rpc-multiplexer.ts`, `fragmentation.ts`, Python RTC framing layer, SDK conformance tests.

1. Implement `MeshPeerBridge.call`, `getManifest`, and pending-call cleanup.
2. Implement result/error/chunk/eof/cancel behavior.
3. Implement bounded fragmentation/reassembly and DataChannel backpressure on both languages.
4. Reject inbound calls in consumer-only mode.
5. Preserve audit/redaction metadata through `MeshP2PTransport`.
6. Add forced-small-fragment tests and channel-loss tests.

**Gate:** registry query, a mutating authorized call, a streamed call, cancellation, and a 512 KiB voice payload all interoperate without unbounded queues or duplicate execution.

### Phase 7 — Scoped subscriptions and assistant/TTS parity

**Files:** new Python subscription registry, `app/messaging/mesh_bus.py`, `app/services/gateway/mesh/peer_bridge.py`, `app/services/gateway/webrtc/rpc.py`, Orchestrator/TTS contracts/services, SDK subscriptions/events tests.

1. Add negotiated subscribe/subscribed/unsubscribe frames.
2. Permission-check exact event topics and bind subscriptions to the authenticated stable peer.
3. Filter interested peers before event serialization/sending.
4. Add correlation/peer propagation needed for assistant responses and audio.
5. Enable targeted `TTS.AudioChunk` delivery only through active scoped subscriptions.
6. Ensure unsubscribe, cancel, disconnect, auth revocation, and expiration stop delivery immediately.
7. Add two-peer tests proving one client cannot receive the other's text/audio stream.

**Gate:** `AuroraClient.assistant.streamMessage()` produces text and ordered client TTS audio over WebRTC; a non-subscriber receives zero frames.

### Phase 8 — App runtime integration and UI

**Files:** app client/runtime factories, `packages/aurora-ui/src/platform-surface.ts`, onboarding/settings/diagnostics components, UI tests.

1. Add connection-mode and peer-invite setup to the typed runtime factory.
2. Extend centralized surface capabilities first.
3. Add invite review, expected peer identity, broker/TURN summary, SAS confirmation, connection status, reconnect/disconnect, and redacted diagnostics.
4. Show route badges for HTTP vs peer; show `webrtc-only` failures without falling back silently.
5. Reuse existing assistant and admin routes with no raw transport imports.
6. Preserve desktop-local wakeword ownership and focused WebView push-to-talk.
7. Add accessibility, keyboard, screen-reader, offline/reconnect, and destructive-confirmation tests.

**Gate:** all existing routes operate through `AuroraClient` on a peer runtime, with accurate capability/limitation copy.

### Phase 9 — Tauri desktop security and no-sidecar release

**Files:** Tauri config overlays, package scripts, Rust secure-store commands, capabilities/security docs, CI workflow.

1. Add a production remote/WebRTC config with no `externalBin`/sidecar resources.
2. Tailor CSP to required `https:` and `wss:` destinations. Because endpoints are operator-selected, use scheme-level CSP only when necessary and enforce a stricter application allowlist/profile validator.
3. Add narrow peer-secret store/delete/proof commands; never add generic filesystem/shell access.
4. Add tray/notification connection evidence without background-wake claims.
5. Inspect built AppImage/deb/dmg/MSI/NSIS contents for Python absence.
6. Keep desktop-local bundles and tests unchanged except shared runtime-selection plumbing.

**Gate:** desktop WebRTC-only app pairs with a Python peer whose HTTP API is off, and the artifact contains no Python runtime.

### Phase 10 — Hosted web release

**Files:** `apps/aurora-web` runtime/provider, browser configuration, Playwright matrix, deployment docs.

1. Lazy-load peer runtime only in the browser; keep server rendering deterministic.
2. Use HTTPS and WSS; no persistent browser credential by default.
3. Use URL fragments or paste/import for ephemeral invite material so it is not sent in HTTP requests; redact it from navigation/history where feasible.
4. Handle page visibility, offline/online, suspend/resume, and explicit re-pair after memory loss.
5. Verify PWA/service-worker code does not claim ownership of a persistent peer connection.
6. Run Chromium, Firefox, and WebKit Playwright interop.

**Gate:** hosted web can pair and operate without an Aurora HTTP application server, with documented foreground/session limits.

### Phase 11 — Android foreground release

**Files:** Tauri Android app/plugin/capabilities, runtime adapter, emulator/device tests.

1. Reuse the WebView peer runtime unchanged.
2. Integrate QR/deep-link invite handoff and Keystore-backed proof adapter.
3. Mediate WebView microphone requests explicitly, granting only audio capture for the trusted application origin.
4. Handle network handoff, app pause/resume, process death, and user disconnect deterministically.
5. Keep v1 foreground-only; do not use the notification-only service scaffold as wakeword proof.
6. Run emulator plus physical-device direct/STUN/TURN tests and signed build preflight.

**Gate:** Android foreground HTTP and WebRTC modes pass the same assistant/auth/redaction suite; background limitations are visible.

### Phase 12 — iOS foreground release

**Files:** Tauri iOS app/plugin/capabilities, runtime adapter, simulator/device tests.

1. Reuse the WebView peer runtime unchanged.
2. Integrate deep/universal-link invite handoff and Keychain-backed proof adapter.
3. Implement explicit WKWebView microphone permission handling for the trusted application origin.
4. Handle app active/inactive, process eviction, reconnect, and user disconnect.
5. Keep v1 foreground-only and preserve the no-default-assistant claim.
6. Run simulator plus physical-device direct/STUN/TURN tests and signed/TestFlight preflight.

**Gate:** iOS foreground HTTP and WebRTC modes pass the shared suite with documented lifecycle limits.

### Phase 13 — Rollout, compatibility, and cleanup

1. Ship behind `webrtc_thin_client` and scoped-subscription/fragmentation capability gates.
2. Roll out browser internal preview, desktop preview, hosted web beta, Android beta, then iOS beta.
3. Track protocol/capability mismatch, signaling failure class, ICE path, connect duration, reconnect count, RPC latency, queue pressure, fragment rejection, subscription rejection, and redacted terminal reasons.
4. Provide a kill switch that disables new WebRTC sessions without disabling HTTP or desktop local.
5. Preserve legacy Python-peer event behavior only through a documented compatibility window; remove it after all supported peers advertise scoped subscriptions.
6. Update roadmap/status/docs at every support milestone.

**Gate:** rollback to HTTP/local modes is tested and requires no user credential migration or data loss.

## 8. Testing and verification plan

### Unit tests

- strict parser rejects malformed, oversized, unknown-required, prototype-bearing, and type-confused frames;
- golden crypto, signaling, pairing, reconnect, and fragmentation vectors match Python;
- state machine covers every transition, timeout, explicit disconnect, and retry suppression;
- RPC resolves once, cancels once, ignores late frames, and cleans pending maps;
- fragmentation handles reordering, duplication, hash mismatch, timeout, and quota exhaustion;
- subscriptions enforce exact topics, permissions, correlation, expiry, and cleanup;
- credential adapters never use browser web storage;
- runtime selector does not replay mutations during fallback;
- surface capability logic covers every client catalog profile.

### Cross-language integration tests

Use a real Python `RTCClient`/GatewayService and browser runtime with local Mosquitto WSS and Coturn containers.

Matrix:

- TypeScript offerer -> Python answerer and Python offerer -> TypeScript answerer;
- signaling encryption on; application E2EE off/on;
- first pairing, rejection, expiry, identity mismatch, reconnect proof, revocation;
- direct host, STUN-discovered, and `iceTransportPolicy='relay'` TURN path;
- registry/query, authorized mutation, error, stream, cancel, manifest, ping/pong;
- 512 KiB fragmented upload and large fragmented result;
- scoped assistant text and TTS audio with two connected client peers;
- MQTT interruption, network loss, DataChannel close, process restart, and broker failover;
- Python `api.enabled=false` for the primary no-HTTP acceptance path.

### App end-to-end tests

- hosted web on Chromium/Firefox/WebKit;
- desktop Tauri local remains green;
- desktop Tauri HTTP thin and WebRTC thin runtime switching;
- desktop package content for Linux/macOS/Windows;
- Android emulator plus physical device;
- iOS simulator plus physical device;
- route crawl, assistant, admin, auth, permissions, accessibility, redaction, microphone consent, reconnect, and offline UX.

### Security tests

- malicious retained presence, forged peer ID, wrong room key, AEAD tamper, SDP identity mismatch;
- SAS mismatch, commitment equivocation, replayed reconnect proof, expired invite, revoked peer;
- unauthorized topic subscription, wildcard request, cross-correlation audio leak;
- oversized signaling/RPC/fragment floods and slow consumer/backpressure;
- CSP blocks insecure/unknown remote schemes; endpoint validator blocks credentials-in-URL and non-approved origins;
- logs/support bundles contain none of the seeded test secrets;
- consumer-only thin client rejects inbound service call frames;
- fallback test proves a mutation executes at most once during channel loss.

### Observability checks

Diagnostics must expose:

- state and transition timestamp;
- stable peer ID/name after validation;
- selected broker origin without credentials/path secrets;
- negotiated protocol capabilities;
- ICE path category, not candidate IP/address;
- connect/auth/reconnect duration and counts;
- pending call/stream/subscription/fragment counts;
- buffer pressure high-water mark;
- redacted error code/action.

No diagnostic payload may include SDP, ICE candidate strings, room password, MQTT credentials, peer token, pairing nonce, reconnect proof, raw audio, or raw service params.

## 9. Testable acceptance criteria

1. A Playwright browser connects to a Python Aurora peer with `services.gateway.api.enabled=false` and successfully calls `Gateway.GetRegistry` over `MeshP2PTransport`.
2. TypeScript and Python produce identical committed values for every deterministic golden fixture.
3. Both negotiation directions reach one—and only one—open `aurora-rpc` channel.
4. The displayed SAS is identical on both peers; a one-byte SDP/identity/nonce mutation changes or invalidates it.
5. A confirmed pairing authorizes calls; an unconfirmed, denied, expired, or identity-mismatched pairing cannot call shared services.
6. Reconnect succeeds through challenge/proof without retransmitting a stored long-lived token from native storage into ordinary React state.
7. `call`, result/error, streamed chunk/eof, abort/cancel, and manifest lookup pass cross-language tests.
8. A 512 KiB base64 voice request passes with a forced 16 KiB fragment limit; reassembly never exceeds the configured 8 MiB logical and 16 MiB per-peer caps.
9. DataChannel sends stop when the bounded buffer threshold is reached and resume only on `bufferedamountlow`; closing the channel rejects all pending work within one event-loop turn plus cleanup scheduling.
10. `Orchestrator.Response` and `TTS.AudioChunk` reach only the authorized peer with a matching active subscription/correlation; a second connected peer receives zero matching frames.
11. Assistant text, client audio playback, stop/cancel, and focused push-to-talk work without WebRTC media tracks.
12. `http-only`, `webrtc-only`, and `webrtc-preferred` select the documented transport for new calls; an in-flight mutation is never replayed automatically.
13. Onboarding changes runtime endpoint/invite without rebuilding, closes the old runtime, and does not persist secrets in browser storage.
14. Production web and Tauri profiles reject `ws:` signaling and insecure remote `http:`; loopback development remains available under a separate policy.
15. UI source-boundary tests find no raw MQTT/WebRTC imports outside approved SDK/app runtime adapters.
16. Rust service-boundary tests still reject PyO3/libpython/service-specific business logic.
17. A remote/WebRTC Tauri artifact contains no sidecar executable, CPython library, `.py` source, Python stdlib archive, or Python dependency metadata.
18. Chromium, Firefox, WebKit, desktop Tauri, Android physical-device, and iOS physical-device foreground lanes pass their applicable pairing/request/stream/reconnect cases.
19. Forced TURN relay passes for browser, desktop Tauri, Android, and iOS before public support claims.
20. Seeded tokens/passwords/nonces/audio markers are absent from logs, diagnostics, browser storage, URL query strings, and support artifacts.
21. Existing desktop-local, HTTP web, HTTP thin, SDK conformance, Tauri boundary, Python mesh, and documentation checks remain green.
22. The packaged Android System WebView and standalone Android mobile browser each pair with an external Python `RTCClient` while the Aurora HTTP application API is disabled, and both pass the shared negotiation-direction, pairing, manifest, structured-error, 512 KiB fragmentation, stream/cancel, scoped-event/TTS, reconnect, uncertain-mutation, revocation, and redaction assertions inside one consolidated Android CI check.
23. MobileSafari in an iOS simulator pairs with an external Python `RTCClient` on the direct path while the Aurora HTTP application API is disabled and passes the same shared assertions inside the existing macOS iOS check; this browser-engine evidence must remain explicitly separate from packaged WKWebView and physical-device certification.

## 10. Risks and mitigations

| Risk | Impact | Mitigation / release gate |
| --- | --- | --- |
| Python behavior is implicit and changes during TS work | Cross-language drift | Python-owned golden fixtures, version/capability negotiation, CI drift check. |
| Scrypt blocks UI or differs bytewise | Frozen onboarding or failed decryption | Async Worker implementation, fixed vectors, bundle/device benchmarks, reviewed dependency. |
| Public MQTT retained presence exposes/spoofs discovery | Wrong-peer connection or metadata leak | Encrypted presence, expected stable-peer pin, WSS, authenticated pairing, ignore unrelated peers. |
| Room password/invite leaks | Unauthorized rendezvous attempts | High-entropy/expiring material, fragment/custom-scheme handling, memory/native storage, no logs/history, stable-peer pin. |
| DataChannel message-size differences | Voice/large RPC failures | Capability-negotiated fragmentation, conservative fragment size, quotas, backpressure, forced-limit tests. |
| Broad mesh events leak another session's data | Text/audio privacy breach | Server-side exact scoped subscriptions and correlation/peer binding before TTS mesh enablement. |
| TURN credentials exposed to JS/logs | Relay abuse | Short-lived credentials where available, credential refs/native adapter, redacted diagnostics, rotation. |
| WebView differences | Desktop/mobile-only failures | One standards-based core, browser feature probes, Tauri/mobile physical tests, no support claim from desktop browser alone. |
| Page/mobile suspension drops sessions | Poor reliability | Foreground-only contract, visibility/app lifecycle integration, deterministic reconnect and user-visible state. |
| `webrtc-preferred` duplicates side effects | Data corruption | Never replay in-flight calls; retry only by explicit user/idempotence-aware workflow. |
| CSP widened for arbitrary endpoints | Increased exfiltration surface | Scheme-minimal CSP, strict app profile allowlist, no arbitrary URL credentials, security tests and docs. |
| Browser has no durable secure store | Re-pair friction | Memory-only default; make persistence opt-in only after a separately reviewed WebAuthn/wrapped-key design. |
| Native proof API expands Tauri attack surface | Secret compromise | Narrow peer-scoped store/proof/delete commands, capability restrictions, no generic secret read command. |
| Existing Python peers lack subscription/fragment support | Compatibility split | Additive capability negotiation, compatibility window, diagnostics, staged rollout. |
| Full matrix is expensive/flaky | Slow delivery | Layered deterministic unit tests, containerized interop, small browser smoke per PR, full device/TURN lanes nightly/release. |

## 11. Rollout and rollback

### Feature flags

- `webrtc_thin_client`: enables WebView peer runtime entry points.
- `webrtc_scoped_subscriptions`: enables v2 subscription frames/filtering.
- `webrtc_fragmentation`: enables logical fragmentation.
- `webrtc_app_layer_e2ee`: controls optional data-layer E2EE policy.
- `webrtc_legacy_event_broadcast`: temporary Python-peer compatibility switch; off for sensitive topics and eventually removed.

### Rollout order

1. fixture/protocol CI only;
2. local browser interop harness;
3. internal hosted web preview;
4. desktop Tauri preview/no-sidecar artifact;
5. hosted web beta;
6. Android foreground beta;
7. iOS foreground beta;
8. general release after TURN and device gates.

### Rollback

- Disable `webrtc_thin_client`; leave HTTP and desktop-local runtime factories intact.
- Do not delete stored peer credentials during rollback; mark them inactive so re-enable does not require repair unless the credential was revoked.
- Close MQTT/RTC sessions and pending subscriptions cleanly.
- Never translate or overwrite HTTP credentials as part of peer rollout.
- Maintain profile-schema migration tests and one-version backward read support.

## 12. Documentation and release artifacts

Update with implementation:

- `docs/UI_CLIENT_SURFACE_ROADMAP.md`
- `docs/UI_CLIENT_SURFACE_STATUS.md`
- `docs/FRONTEND_AND_UI_ARCHITECTURE.md`
- `docs/FEATURE_MATRIX.md`
- `docs/GATEWAY.md`
- `docs/PEER_PAIRING_FLOW.md`
- `docs/AUTH_AND_PERMISSIONS.md`
- `docs/TAURI_DESKTOP_BUILD.md`
- `packages/aurora-sdk/README.md`
- `packages/aurora-ui/README.md`
- `apps/aurora-web/README.md` if present/created
- `apps/aurora-tauri/README.md`
- `apps/aurora-tauri/SECURITY.md`
- Android/iOS package-local platform docs

Run `uv run python scripts/check_docs.py` after every documentation milestone.

## 13. External primary references

- Tauri content security policy: <https://v2.tauri.app/security/csp/>
- MDN `RTCPeerConnection.createDataChannel()`: <https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel>
- MDN WebRTC data channels: <https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels>
- MDN `RTCDataChannel`: <https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel>
- MQTT.js browser/WebSocket support: <https://github.com/mqttjs/MQTT.js>
- MDN Web Crypto `SubtleCrypto`: <https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto>
- MDN `getUserMedia()` secure-context behavior: <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia>
- Android WebView `PermissionRequest`: <https://developer.android.com/reference/android/webkit/PermissionRequest>
- Apple WKWebView: <https://developer.apple.com/documentation/webkit/wkwebview>
- Apple WebRTC/getUserMedia in WKWebView session: <https://developer.apple.com/videos/play/wwdc2021/10032/>

## 14. Final verification commands and evidence bundle

Exact script names may be added by implementation, but the final evidence bundle must include the equivalent of:

```bash
# Python protocol and peer behavior
uv run pytest -q \
  tests/unit/services/gateway \
  tests/integration/services/gateway

# SDK unit/conformance and WebRTC protocol
pnpm --filter @aurora/client typecheck
pnpm --filter @aurora/client test
pnpm --filter @aurora/client build

# Shared UI and app runtime boundaries
pnpm --filter @aurora/ui test
pnpm --filter @aurora/tauri-ui typecheck
pnpm --filter @aurora/tauri-ui test
pnpm --filter @aurora/tauri-ui test:service-boundary

# Cross-language browser/TURN harness (new scripts)
pnpm test:webrtc:interop
pnpm test:webrtc:turn
pnpm test:webrtc:browsers

# Packaging and platform lanes (new/extended scripts)
pnpm --filter @aurora/tauri-ui build:bundle:remote
pnpm --filter @aurora/tauri-ui test:bundle:no-sidecar
pnpm --filter @aurora/tauri-ui android:preflight:strict
pnpm --filter @aurora/tauri-ui ios:preflight:signing

# Documentation
uv run python scripts/check_docs.py
```

Preserve raw CI artifacts for:

- protocol fixture diff;
- interop logs with seeded-secret scan results;
- TURN path evidence;
- browser/device matrix;
- package content manifest;
- redacted connection diagnostics;
- existing-path regression results.

## 15. Implementation handoff order

This is a multi-lane program, but dependencies are strict:

1. protocol fixtures and HTTP/no-sidecar baseline;
2. crypto and signaling;
3. session/DataChannel;
4. pairing/auth/reconnect;
5. RPC/fragmentation;
6. scoped subscriptions/TTS;
7. shared app/UI integration;
8. desktop security/package;
9. hosted web;
10. Android;
11. iOS;
12. release certification.

Do not begin platform release claims before the cross-language browser harness passes with the Python HTTP API disabled. Do not enable peer TTS audio before scoped subscriptions and two-peer isolation tests pass. Do not call a Tauri build “no-sidecar” until package contents are inspected, not merely until runtime startup is disabled.
