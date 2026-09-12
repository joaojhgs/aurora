# Vendored `webrtc-dtls` — Aurora provenance

**This directory is not Aurora code.** It is an unmodified copy of the published
crate below, with exactly one source change, carried only until upstream ships a
release that contains it.

| | |
|---|---|
| Upstream crate | `webrtc-dtls` |
| Upstream version | `0.10.0` (crates.io, checksum `86e5eedbb0375aa04da93fc3a189b49ed3ed9ee844b6997d5aade14fc3e2c26e`) |
| Upstream repository | <https://github.com/webrtc-rs/webrtc> |
| Licence | MIT OR Apache-2.0 (unchanged — see `LICENSE-MIT`, `LICENSE-APACHE`) |
| Files changed | `src/flight/flight0.rs`, and nothing else |
| Removed from the copy | registry bookkeeping (`.cargo-ok`, `.cargo_vcs_info.json`, `Cargo.toml.orig`, `Cargo.lock`, `.gitignore`, `codecov.yml`); `doc/`; `examples/` and their `[[example]]` stanzas — the library builds without them, and the example fixtures include files named like private keys, which have no business in this repository |

## What changed

`src/flight/flight0.rs` — the DTLS **server** flight adopted the peer's
most-preferred elliptic curve without checking whether this version can generate
a keypair for it:

```rust
state.named_curve = e.elliptic_curves[0];
```

It now walks `supported_groups` and takes the first *mutually* supported curve,
which is what `webrtc-dtls 0.12` does upstream.

## Why

Current Chromium leads its `supported_groups` extension with a post-quantum
hybrid group. `webrtc-dtls 0.10` maps that to `NamedCurve::Unsupported`, then
tries to generate a keypair from it, and the handshake dies:

```
[handshake:server] Flight 0 result alert:Fatal/IllegalParameter, err:ErrInvalidNamedCurve
Failed to start manager dtls: invalid named curve
Failed to start SCTP: DTLS not established
```

ICE connects on both sides first, so this reads as a late, confusing failure.
It bites whenever the browser picks `setup:active` — the client flight is
unaffected — and it is not Chromium-specific: any peer that leads with a group
this version does not know reproduces it.

Aurora's native transport (`apps/aurora-tauri/src-tauri/src/native_webrtc.rs`)
has to answer browsers, so this is load-bearing rather than cosmetic. With the
change applied, all three lanes of `scripts/webrtc_native_interop.sh` pass —
aiortc, chromium with mDNS off, chromium with mDNS on.

## Why vendored instead of upgraded

The fix exists upstream in `webrtc-dtls 0.12`, but the umbrella `webrtc 0.11`
crate Aurora uses pins `webrtc-dtls = "0.10.0"`, so it cannot be reached by a
version bump. Getting there through the umbrella means moving to `webrtc`
0.20.x/0.21, which is an API redesign (`RTCConfigurationBuilder`, a new runtime
module) and — measured against 0.10 — buys nothing else: same curves, same
cipher suites, still DTLS 1.2 only.

## How it is wired

Both consumers point `[patch.crates-io]` at this directory, so the whole
dependency graph below `webrtc 0.11` resolves to the patched copy:

- `apps/aurora-tauri/src-tauri/Cargo.toml` — the Tauri shell.
- `tests/e2e/webrtc_native_interop/peer/Cargo.toml` — the interop lane peer,
  which declares its own `[workspace]` and therefore needs its own stanza.

## Removing this directory

Delete it, and delete both `[patch.crates-io]` stanzas, as soon as either:

- a `webrtc-dtls 0.10.1` (or any `0.10.x`) release carries the fix — every
  `webrtc 0.11` user picks it up automatically, since the dependency is `^0.10.0`; or
- Aurora moves to a `webrtc` release whose `webrtc-dtls` is `>= 0.12`.

`scripts/webrtc_native_interop.sh` with `AURORA_NATIVE_INTEROP_REQUIRE_BROWSER=1`
is the check that says whether it is still needed.

---

## Upstream PR — prepared, not opened

`upstream-pr.patch` in this directory is the diff to submit. It is the same
change without the Aurora-local explanatory comment, so it matches what
`webrtc-dtls 0.12` already carries. **It has not been sent**; opening it is a
follow-up that needs network access and a GitHub account.

- **Repository:** <https://github.com/webrtc-rs/webrtc>
- **Branch to target:** the `webrtc-dtls 0.10.x` maintenance line
- **Apply with:** `git apply upstream-pr.patch` from the `dtls` crate root

### Title

`dtls: backport mutually-supported named-curve selection to 0.10.x`

### Body

> `webrtc-dtls 0.10` accepts `elliptic_curves[0]` from the ClientHello without
> checking that it is a curve this crate can generate a keypair for. Current
> Chromium leads `supported_groups` with a post-quantum hybrid, which parses as
> `NamedCurve::Unsupported`, so the server flight aborts with
> `Fatal/IllegalParameter` + `ErrInvalidNamedCurve` and the connection never
> gets past DTLS. ICE has already succeeded by then, which makes it read as a
> transport failure rather than a handshake one.
>
> This affects any peer whose most-preferred group is unknown to this version,
> not only Chromium, and only the server flight — a `setup:passive` browser does
> not reproduce it.
>
> `0.12` already fixes this by selecting the first mutually supported curve.
> This is that change, backported unchanged, so it can ship as `0.10.1`.
> `webrtc 0.11` depends on `webrtc-dtls` as `^0.10.0`, so a patch release reaches
> every current user of the umbrella crate without an API break; today they can
> only get the fix by moving to `webrtc` 0.20.x/0.21, which is a redesign.
>
> Verified against Chromium 149 (host candidates and mDNS candidates) and against
> aiortc, opening a data channel and echoing ordered messages up to 16 KB
> byte-exact in every case.
