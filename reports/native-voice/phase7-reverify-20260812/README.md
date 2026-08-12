# Phase 7 browser-voice disposition

Recorded: 2026-08-12T00:11:00Z

Verdict: **disposition-verified PARTIAL**.

The current Rust/WASM browser runtime, foreground push-to-talk lifecycle,
single capture ownership, remote route preservation, model-store controls,
bundle ceilings, and production-copy gate pass their bounded current-source
checks. Phase 7 may hand off to Phase 8 only with production VAD, KWS, STT,
and TTS still false.

This does not prove Phase 7 complete. Hosted Chromium and Pixel 5 Chromium
emulation use fake media. Worker/WASM coverage in Firefox and WebKit uses
fixture audio rather than a hosted microphone. No real microphone, acoustic
recognition, operating-system permission prompt, physical device, actual
mobile browser, or durable web background behavior is claimed.

## Current-head results

- `@aurora/voice-web` passed 151 unit tests, 35 Worker/WASM browser cases
  across five profiles, two browser-API fake-media cases, typecheck, and build.
- Browser model storage passed 25 cases with two expected platform-specific
  skips across Chromium, Firefox, and WebKit.
- A clean detached worktree at `a14ee758` passed all 77 hosted-web unit tests,
  typecheck, a 24-of-24 production build, and two hosted Assistant fake-media
  cases in desktop Chromium and Pixel 5 Chromium emulation.
- Current UI route and lifecycle checks passed 129 focused tests and the
  69-file, 734-test package suite. The Assistant owns no direct browser
  microphone implementation; the shared runtime remains the only focused web
  capture owner.
- Hidden, frozen, discarded, and page-hide states cancel capture. Late media
  streams are stopped before activation and cannot resurrect a stale session.
- Remote STT/TTS identity and explicit-selection fail-closed behavior pass.
  `Tooling.ExecuteTool` is not used as foreground voice evidence.
- The generated Worker is 43,202 bytes, WASM core is 144,904 bytes, and WASM
  loader is 21,606 bytes; all remain within their recorded ceilings.
- Commit `e2f87d24` replaced two internal implementation-coded digest reasons.
  The broad production-copy scan, ten focused pack-policy tests, UI/web
  typechecks, GitNexus staged detector, and independent review then passed.

## Environment disposition

Waydroid was the only Android target attempted. ADB reported no device,
`waydroid0` had no carrier, the endpoint was unreachable, no Waydroid runtime
was active, and the shell had no usable host audio input. QEMU was not started
because this gate did not require a specific emulator image and Waydroid is
the required default target. These are external environment blockers, not an
Aurora application failure.

## Remaining gates

- Real hosted Firefox and Safari microphone push-to-talk.
- Physical microphone, acoustic recognition, and permission-prompt behavior.
- Actual Android and iOS mobile-browser lifecycle validation.
- Approved production speech packs, production installer, and quality gates.
- Signed artifacts, final hashes, SBOM/license inventory, runtime rollback,
  store review, battery, thermal, and endurance evidence.

RAC-21, RAC-23, RAC-24, and RAC-26 remain pass. RAC-22 and RAC-25 remain
partial. The global matrix counts remain 22 pass, 24 partial, 6 withheld, and
4 blocked.

`summary.json` is the machine-readable disposition. `checksums.sha256` binds
the plan, the earlier detailed Phase 7 checkpoint, the Phase 6 disposition,
the production-copy remediation, and the generated browser runtime artifacts
used by this decision.
