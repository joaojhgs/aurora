# Phase 7 browser-voice hardening checkpoint

**Status:** Current bounded check

Implementation commit `a28aa5fc` hardens the Phase 7 browser model-pack transaction and corrects the focus-limited wake label. It does not complete Phase 7 or promote any RAC status.

## Accepted evidence

- Browser model-pack fetch and staging accept an `AbortSignal`; cancellation before promotion leaves no new active metadata or promoted blobs.
- Every selected file is verified before promotion begins.
- Immutable manifest-generation keys prevent a failed same-version reinstall from corrupting an already active pack.
- Promotion snapshots active, installed, and manifest metadata; a failed commit restores the prior JSON state and removes only newly promoted blobs.
- Cleanup failures are surfaced while retaining the primary failure classification. Maximum-length pack IDs remain within the browser host key limit, and `removePackData(packId)` still groups every generation correctly.
- Focus-limited browser surfaces render `Wake while open`; `Wake and background` remains reserved for a future surface that can actually sustain background wake behavior.
- Browser privacy assertions exclude non-sensitive timestamps before checking that PCM/transcript markers are absent. An initial Firefox run hit the timestamp false positive; the corrected exact-source five-engine rerun passed.

## Fresh verification

- `pnpm --dir packages/aurora-voice-web typecheck` — passed.
- `pnpm --filter @aurora/voice-web run build` — passed, including Rust/WASM and Worker artifacts.
- Focused model/storage Vitest — 3 files, 42/42 passed.
- Full `@aurora/voice-web` Vitest — 12 files, 119/119 passed.
- Browser model storage Playwright — 18/18 across Chromium, Firefox, and WebKit.
- Production Worker/WASM voice Playwright — 35/35 across Chromium, Firefox, WebKit, Android Chrome emulation, and Mobile Safari emulation.
- `pnpm --filter @aurora/ui typecheck` and `pnpm --filter @aurora/ui run build` — passed.
- Hosted browser-voice UI Vitest through the normal package configuration — 39/39 passed.
- Full `@aurora/ui` Vitest — 67 files, 700/700 passed.
- `git diff --check` and staged diff checks — passed.
- Independent storage, cancellation, simplification, UI, and redaction reviews — approved with no remaining findings.
- GitNexus staged change detection — 8 files, 73 changed symbols, 0 affected processes, low risk.

## Bounded scope and remaining gates

- RAC-21 and RAC-23 remain `pass`; RAC-24 and RAC-26 retain their existing `pass` verdicts.
- RAC-22 remains `partial`: browser automation uses deterministic injected PCM and does not prove real microphone capture, acoustic behavior, actual mobile browsers, or physical devices.
- RAC-25 remains `partial`: no production caller currently invokes `installVerifiedBrowserModelPack`; an approved production pack, end-to-end verified-pack offline reuse, signing, final Android/iOS artifact hashes, SBOM/license tooling, and external release evidence remain open.
- ADB to the requested Waydroid endpoint `192.168.240.112:5555` returns `No route to host`; there is no connected ADB device or MobileMCP surface in this runtime. No current-source Waydroid UI, microphone, navigation, or screenshot claim is made.
- OS suspension/background behavior, physical ARM64/iOS evidence, endurance, battery, thermal, and store/distribution gates remain open.

The earlier `Tooling.ExecuteTool` work belongs to RAC-27 only. It is a bounded reverse-RPC/backpressure/authentication canary for the shared WebRTC DataChannel used by voice traffic; it is not a Tooling feature dependency and is not part of this Phase 7 implementation checkpoint.
