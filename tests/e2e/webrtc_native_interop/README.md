# Native WebRTC transport interop

Aurora runs WebRTC through `webrtc-rs`
(`apps/aurora-tauri/src-tauri/src/native_webrtc.rs`). It started out gated to
Linux, where WebKitGTK has no `RTCPeerConnection` and the Rust stack is the only
way through; it now compiles for every platform the shell ships to — linux,
macos, windows, android, ios — because moving mobile onto that same stack is
what lets mesh sessions survive the background, and a webview cannot be trusted
to keep running when the app is not in front of the user.

Before that move, the stack has to be proven against every peer it will meet.
This lane does that, independently of the Tauri app, so a failure points at the
transport rather than at the shell.

## Lanes

| Lane | Peer | Gating |
|---|---|---|
| `aiortc` | the Python mesh node's stack | required |
| `chromium-direct` | browser peer, host candidates | required |
| `chromium-mdns` | browser peer, default mDNS candidates | required |

CI runs all three as gating with `AURORA_NATIVE_INTEROP_REQUIRE_BROWSER=1`.
Leaving that variable unset downgrades the browser lanes to informational, which
is only worth doing while bisecting the transport itself.

Each lane opens an `aurora-rpc` data channel, sends eight ordered small messages
plus one payload at Aurora's 16 KB fragment size, and asserts the remote echo is
byte-identical and in order. That is exactly what mesh RPC depends on.

```bash
scripts/webrtc_native_interop.sh
AURORA_INTEROP_BROWSER=firefox scripts/webrtc_native_interop.sh
AURORA_INTEROP_LARGE_LEN=65535 scripts/webrtc_native_interop.sh
```

## Known findings

**Chromium failed on stock `webrtc-dtls 0.10` — fixed, vendored.** The fix now
ships in `apps/aurora-tauri/src-tauri/vendor/webrtc-dtls`, wired through
`[patch.crates-io]` from both the Tauri shell and this lane's peer, so all three
lanes pass. What follows is the diagnosis, kept because it is what a recurrence
would look like. ICE connected on both sides, then DTLS aborted: Chromium
reported `iceConnectionState: connected` with `connectionState: failed`, and the
Rust peer logged

```
[handshake:server] Flight 0 result alert:Fatal/IllegalParameter, err:ErrInvalidNamedCurve
Failed to start manager dtls: invalid named curve
Failed to start SCTP: DTLS not established
```

`webrtc-dtls 0.10` takes `elliptic_curves[0]` from the ClientHello without
checking it (`src/flight/flight0.rs:114`). Current Chromium leads its
`supported_groups` with a post-quantum hybrid, which maps to `Unsupported`, and
the server flight then tries to generate a keypair from it. Only the DTLS
**server** path is affected, so it bites whenever the browser selects
`setup:active` — and it affects any browser that leads with a group this version
does not know, not only Chromium.

`webrtc-dtls 0.12` fixes it by selecting the first *mutually supported* curve.
`patches/webrtc-dtls-0.10-named-curve.patch` backports that loop, and the
vendored crate carries it applied. Upgrading the umbrella `webrtc` crate instead
means moving to 0.20.x/0.21, which is an API redesign
(`RTCConfigurationBuilder`, new runtime module) and — measured against 0.10 —
carries no other benefit: same curves, same cipher suites, still DTLS 1.2 only.
`apps/aurora-tauri/src-tauri/vendor/webrtc-dtls/README.aurora.md` records the
provenance, the upstream PR to open, and the conditions for deleting the copy.

**Single-message ceiling is 65,535 bytes — now enforced.** 65,535 round-trips;
65,536 sends but never returns; 131,072 fails outright with `outbound packet
larger than maximum message size`. Aurora fragments at 16 KB so its own traffic
is clear, but the transport no longer relies on that headroom: both
`native_webrtc.rs` and `apps/aurora-tauri/src/native-webrtc.ts` reject an
oversize message with a typed error rather than letting it leave and never
arrive.

**Android builds clean.** `cargo check --target aarch64-linux-android` against
NDK 27 compiles the whole tree — ice, dtls, sctp, data, turn, sdp — for this
peer and for the Tauri shell that now carries the transport.

## Not covered yet

Firefox and WebKit lanes (`AURORA_INTEROP_BROWSER`) are runnable but unverified;
Firefox is likely to hit the same curve bug. iOS cannot be built or run here.
