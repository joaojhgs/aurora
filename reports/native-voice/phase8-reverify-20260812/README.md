# Phase 8 desktop native-voice disposition

Recorded: 2026-08-12T01:59:05Z

Verdict: **disposition-verified PARTIAL**.

The current-source Linux desktop slice passes its bounded native runtime gate.
A real Tauri debug binary used the real CPAL capture path with paced virtual
ALSA PCM, drove completed, hidden-window tray, and cancelled turns through a
repository-owned loopback Gateway, and emitted only redacted bounded evidence.
Persisted runtime role remained authoritative when sidecar state changed, and
the WebView used no microphone, model loader, Worker, or SharedWorker.

This is not a Phase 8 completion claim. Virtual PCM is not a physical
microphone or acoustic result, the fake Gateway is not a production sidecar or
remote peer, and hiding the window does not prove fully closed-UI residency.
Windows/macOS/Linux signed builds, installers, operating-system lifecycle
matrices, approved speech packs, SBOM/license inventory, and release rollback
remain open.

## Current-source results

- Rust desktop capture passed rustfmt and 24 focused tests. The E2E-only CPAL
  buffer uses a 10 ms period only in a debug process with the explicit E2E
  environment flag; the production default remains CPAL-managed.
- Tauri native voice passed 22 focused tests covering tray policy, persisted
  role selection, remote consent, cleanup ordering, cancellation, and redacted
  monotonic status.
- The desktop E2E UI passed eight tests, TypeScript typecheck, production
  frontend build, harness self-test, and readiness check.
- The Tauri release-profile Cargo check passed without the E2E feature.
- The live run completed in 8,990 ms. Completed, tray, and cancelled turns all
  observed both start and terminal states with distinct generations and
  monotonic status sequence numbers.
- Gateway counts were CapturePrepare 3, CaptureRelease 3, Transcribe 3,
  ExternalUserInput 3, Interrupt 1, TTS Synthesize 2, and event-stream 7.
- Remote-console remained remote with and without a running sidecar and failed
  closed on connected-audio consent. Mesh-node/python-full with a running
  sidecar selected the loopback sidecar route.
- Independent verification approved a bounded PARTIAL receipt. Independent
  code review reported zero findings and zero blockers.

## Remaining gates

- Physical microphone, acoustic recognition, and permission prompts.
- Fully closed UI plus durable tray/background lifecycle across sleep, wake,
  device changes, network loss, sidecar restart, and dual instances.
- Real local Python sidecar and authorized remote-peer full turns.
- Signed Windows, macOS, and Linux release artifacts and installers.
- Approved production speech packs and production quality/resource gates.
- SBOM/license inventory, release artifact hashes, runtime rollback, security
  review, and staged rollout.

RAC-28 advances from withheld to partial because a hidden-window tray turn now
passes. RAC-27, RAC-30, and RAC-31 remain partial; RAC-29 remains pass; RAC-32
remains blocked. Production VAD, KWS, STT, and TTS remain false.

`summary.json` is the machine-readable disposition. `checksums.sha256` binds
the plan, the preceding Phase 7 receipt, the source files that enforce the E2E
boundary, and the transient live reports and binary used for this decision.
