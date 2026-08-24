# Thin-Client Mesh Parity — Implementation Plan

Bring the web and mobile thin runtimes to the same multi-peer behaviour as the Python
node, and move the mobile connection onto the native Rust stack so it survives the
background. Connect stays a deliberate single-peer restriction, not an architectural one.

**Implementation status:** complete on `mesh-parity-implementation`. The automated release
gates and the requested Waydroid full-stack acceptance pass against the real `main.py`
supervisor with a local CPU model. Waydroid proves protocol behaviour, service hold,
process survival, reconnect, and bounded background tool serving; it does not replace the
separate physical-device Doze, OEM-kill, battery, or thermal release gate documented in
[`BACKGROUND-MEASUREMENT.md`](BACKGROUND-MEASUREMENT.md).

## Current state (already committed on this branch)

- `f3ede57a` — local **forget device**: `forgetSavedPeer()` in
  `packages/aurora-ui/src/web-thin-runtime.ts`, detail-sheet control and best-effort
  orchestration in `mesh-peers-view.tsx`, plus a regression test for re-pairing when a
  remote answers a reconnect challenge with a fresh pairing commit.
- `35705bb9` — **native transport interop lane** at `tests/e2e/webrtc_native_interop/`,
  `scripts/webrtc_native_interop.sh`, and the `native-transport-interop` CI job.

## Measured evidence (do not re-derive)

- **webrtc-rs 0.11 builds for Android.** `cargo check --target aarch64-linux-android`
  against NDK 27 compiles ice, dtls, sctp, data, turn, sdp.
- **aiortc pairing works.** Nine ordered messages echoed byte-exact including a 16 KB
  payload at Aurora's fragment size.
- **Chromium 149 fails at DTLS.** ICE connects on both sides; the handshake aborts with
  `Fatal/IllegalParameter` + `ErrInvalidNamedCurve`. `webrtc-dtls 0.10`
  (`src/flight/flight0.rs:114`) takes `elliptic_curves[0]` without checking support, and
  current browsers lead with a post-quantum group. Only the DTLS **server** flight is
  affected. `webrtc-dtls 0.12` fixes it by selecting the first mutually supported curve;
  the backport is at `tests/e2e/webrtc_native_interop/patches/`. With it applied all three
  lanes pass. Do **not** take the 0.20.x/0.21 upgrade for this — it is an API redesign
  with no other measurable benefit (same curves, same cipher suites, still DTLS 1.2).
- **Single-message ceiling is 65,535 bytes.** 65,535 round-trips, 65,536 does not,
  131,072 fails outright.

## Settled decisions

- DTLS curve fix ships **vendored now** under `[patch.crates-io]`, upstreamed in parallel.
- A backgrounded phone stays **reachable** and **serves tools**, but **defers
  orchestration** with a typed "deferred, retry when foreground" response.
- **Tool dispatch and authorization move to Rust.** TypeScript becomes a consumer —
  Tauri IPC on native, WebAssembly on web.
- Thin peers may pair with each other; the invite is for the mesh, with the issuing peer
  pre-selected in Connect.
- iOS takes parity with a deliberately smaller budget.
- Forgetting a peer does **not** rotate the room secret — it revokes approval, not
  reachability.
- Remaining shared mesh core (pairing/SAS/protocol/manifest) stays parked.

## Invariants — each needs a test that fails loudly

- Room membership is not authority. Every peer still needs its own SAS pairing and
  explicit approval.
- Dropping `expectedStablePeerId` from the signaling filter removes an anti-impersonation
  control; a per-session allowlist must replace it.
- One stable id, one session — Python already rejects a stable identity on a second
  transport; the SDK needs the same rule once it holds several.
- Reconnect challenges stay single-use per peer with the existing replay guard.
- Authority contexts never cross peers.
- One Aurora in the notification shade: voice and mesh share one foreground service.
- Runtime is chosen by platform, never by lifecycle — a native shell uses Rust in
  foreground and background alike.
- Shedding a peer to stay inside budget must be distinguishable from a lost peer and must
  not cost a re-pair.
- Product copy stays product copy — internal role names and transport jargon stay out of
  user-facing strings (`packages/aurora-ui/src/product-copy-forbidden-terms.ts`).

## Track A — multi-peer parity

Chokepoints: `runtime.ts:242,244` (one `session`, one `bridge`), `runtime.ts:466`
(transport bound to `defaultPeerId`), `signaling-mqtt.ts:500` (drops presence from any
peer that is not the invited one), `mesh-invite.ts` (invite encodes one `node.peer_id`),
`webrtc-peer-host.ts:109` (`lastRecipientPeerId` single mutable state),
`mesh-peers-view.tsx` (roster derived from the single `thinPeer` snapshot).

Already per-peer capable, reuse rather than rewrite: `WebRtcMeshPeerBridge`
(`mesh-peer-bridge.ts:173`), `WebRtcPeerHost.handleCall(frame, remotePeerId, …)`,
`PeerCredentialStore` (keyed by peerId), hello negotiation, fragmentation, backpressure,
manifest ACK, provider leases, event subscriptions.

- **W1 — peer registry in the thin runtime.** Replace the runtime singletons with a map
  keyed by stable peer id; each entry owns its session, auth port, bridge, pairing state,
  snapshot. Emit a roster snapshot; keep the single-peer snapshot as a derived view.
  *Done when* two simultaneous authorized sessions can be driven in the harness with
  independent pairing state and the existing single-peer tests pass untouched.
- **W2 — bridge router.** A `MeshPeerBridge` implementation dispatching `call`,
  `streamCall`, `getManifest` to the per-peer bridge for `request.peerId`.
  *Done when* a request naming peer B is answered by peer B while peer A is connected, and
  an unroutable peer id fails with a typed error.
- **W3 — presence roster.** Replace the hard `expectedStablePeerId` drop with an observed
  roster; keep an explicit per-session allowlist so a session only accepts signaling from
  the peer it belongs to. *Done when* a client in a three-node room reports all three, and
  a forged envelope cannot drive an existing session.
- **W4 — invite v2.** `amv2.` carrying room, brokers, room secret and `origin_peer_id`;
  keep decoding `amv1.` forever, treating its `node.peer_id` as an origin hint.
- **W5 — onboarding peer discovery and selection.** List discovered peers with name, short
  id and pairing state; Connect pre-selects the origin peer; Mesh allows several.
- **W6 — Connect restriction.** One policy check in the peer registry, not a structural
  limit. Budgets live in R6.
- **W7 — per-peer trust lifecycle. Implemented.** Pairing, approval and forget per peer; prune orphaned
  rows left when a reinstall mints a new stable id (`localStablePeerId` is
  `aurora-thin-${crypto.randomUUID()}`, so clear-data reinstalls orphan the old row on
  Python — visible today as two hosted-web rows). Python needs the same pruning.
- **W8 — concurrency hardening and parity audit. Implemented.** Walk the Python per-peer state map
  (`rtc_client.py:391–515`) subsystem by subsystem; every row green or a written exclusion.
  The completed audit covers 83 fields, has no unresolved gaps, and records the two
  non-applicable exclusions in [`W8-PYTHON-SDK-PARITY-AUDIT.md`](W8-PYTHON-SDK-PARITY-AUDIT.md).

## Track B — native runtime and background

- **R0 — native/TypeScript boundary. Gates W1, R2, R3.** The substance is decided:
  transport, liveness, tool dispatch and authorization on the Rust side; orchestration and
  UI in TypeScript. R0 writes it precisely — frame-ownership table, who owns negotiated
  `protocol_hello` limits once Rust fragments, what a backgrounded reconnect may do
  without the TypeScript auth state machine, and the typed deferral response.
- **R1 — de-Linux the native transport.** Move `webrtc`/`bytes` off the Linux-only target
  block; rename `mod linux` → `mod native`; widen `supportsNativeWebRtcBridge`. Vendor
  `webrtc-dtls 0.10` with the curve backport; open the upstream PR alongside. Put it behind
  its own rollout flag with a kill switch. *Done when* all three interop lanes are green
  with `AURORA_NATIVE_INTEROP_REQUIRE_BROWSER=1`, the Linux `desktop-client-live` job still
  passes, messages above 65,535 bytes are rejected with a typed error, and the flag turns
  it off in one setting.
- **R2 — mesh authority core in Rust.** Port `packages/aurora-sdk/src/peer-host/`
  authority, authorization, grant-management, contract-registry and types (~77 KB) into
  `rust/crates/aurora-mesh-authority`. Expose via Tauri commands on native and
  `wasm-bindgen` on web, following the `aurora-voice-wasm` precedent. *Done when* Rust and
  TypeScript agree on a shared fixture corpus covering grants, permission evaluation,
  execution policy and denial paths including the hostile cases, the web build runs the
  WASM authority, and **the TypeScript implementation is deleted rather than kept as a
  fallback** — two authorities is drift in the one layer where drift is a vulnerability.
- **R3 — session liveness and background tool serving.** Rust owns connection, framing,
  fragmentation/reassembly and answers `ping` itself; with R2 in place it dispatches tool
  calls while the webview is frozen (authorize, execute against the existing
  `aurora_local_data_*` commands, reply). Orchestration returns the deferral type. Fix
  `lastRecipientPeerId` here. *Done when* a backgrounded phone holds its session past the
  120s stale window, answers a remote tool call with the same authorization decision it
  would make in foreground, and drains queued frames in order on resume with no re-pairing
  — verified by an adb-driven background soak on the physical device.
  **Local acceptance complete:** the current x86_64 Android build stayed backgrounded on
  Waydroid beyond the 120-second stale window, served `native.get_device_status` through the
  real Python Tooling API with the same native connection, logged the Rust served marker,
  kept one connected-device notification, drained its ordered queue on resume, and
  reconnected without pairing after both app force-stop and full server restart. The
  physical-device release gate remains separate as described above.
- **R4 — one foreground service, one notification.** Prerequisite for observing R3.
  Generalise `AuroraVoiceForegroundService` into one runtime service with reference-counted
  reasons; add `FOREGROUND_SERVICE_CONNECTED_DEVICE` and
  `foregroundServiceType="microphone|connectedDevice"` (prefer `connectedDevice` over
  `dataSync` — better semantics, avoids the Android 15 daily cap). Denied notification
  permission degrades visibly without stopping sessions.
- **R5 — background measurement harness.** adb-driven: battery, memory, thermal, survival
  time per peer count, foreground and background, with background tool calls arriving.
  Produces the numbers R6 is set from.
- **R6 — connection budget and peer priority.** Budget keyed by surface and lifecycle
  state. Starting defaults until R5 replaces them: mobile 8 foreground / 2 background,
  desktop unbounded, ordered user-pinned → depended-upon → most recently used. **Contract
  change:** an explicit "going away, keep my credential" signal so Python distinguishes
  intentional absence from a lost peer instead of evicting at 120s — regenerated contracts
  and cross-language fixtures.
- **R7 — iOS background profile.** Parity with a smaller budget; suspend-and-resume is the
  expected path, not a failure.
- **R8 — system assistant reaches the mesh. Implemented.** `ROLE_ASSISTANT`,
  `AuroraAssistActivity`, and the voice interaction services route one scoped system
  assistant path through the native session and paired mesh to the selected assistant
  provider. Repeated starts are serialized, late callbacks are session-scoped, and the
  completed Waydroid run proved two uninterrupted real-server turns plus successful turns
  after app force-stop and full server restart, without a visible reconnect or a second
  notification.
- **R9 — remaining shared mesh core. Parked** on a written ESP32 constrained-peer profile.

## Sequencing

- **M0** R0 boundary — gates M1 and M4
- **M1** W1, W2 — built to the M0 seam
- **M2** R1 native transport — parallel with M1
- **M3** W3, W4, W5, W6 — discovery, invites, onboarding
- **M4** R2 authority core — gates background tool serving
- **M5** R4, R5 — foreground service and measurement
- **M6** R3 — background sessions and tools
- **M7** R6, R7 — budgets and iOS
- **M8** R8, W7, W8 — assistant, lifecycle, hardening — complete

## Constraints

- Do **not** push. Commit coherent, verified slices as you go.
- Leave `AGENTS.md`, `CLAUDE.md` and untracked `.claude/skills/gitnexus/**` alone.
- Another agent is concurrently editing HTTPS/voice files on the parent branch:
  `apps/aurora-web/**`, `packages/aurora-ui/src/{assistant-view,browser-speech-pack,platform-surface,voice-settings-view}.ts*`
  and their tests. Do not revert or absorb those.
- Follow the root `AGENTS.md` as the development contract. Typed bus contracts only, no
  literal topics. No `VITE_AURORA_RUNTIME_MODE`.
- Verify before claiming completion; if tests fail, say so with the output.
