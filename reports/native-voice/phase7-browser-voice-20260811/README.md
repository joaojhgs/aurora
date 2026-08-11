# Phase 7 browser-voice hardening checkpoint

**Status:** Current bounded check

Implementation commits `a28aa5fc` and `e1e92f22` harden the Phase 7 browser model-pack transaction, browser Worker/WASM asset resolution, focused push-to-talk path, and end-user copy. They do not complete Phase 7 or promote any RAC status.

## Accepted evidence

- Browser model-pack fetch and staging accept an `AbortSignal`; cancellation before promotion leaves no new active metadata or promoted blobs.
- Every selected file is verified before promotion begins.
- Immutable manifest-generation keys prevent a failed same-version reinstall from corrupting an already active pack.
- Promotion snapshots active, installed, and manifest metadata; a failed commit restores the prior JSON state and removes only newly promoted blobs.
- Cleanup failures are surfaced while retaining the primary failure classification. Maximum-length pack IDs remain within the browser host key limit, and `removePackData(packId)` still groups every generation correctly.
- Focus-limited browser surfaces render `Wake while open`; `Wake and background` remains reserved for a future surface that can actually sustain background wake behavior.
- Browser privacy assertions exclude non-sensitive timestamps before checking that PCM/transcript markers are absent. An initial Firefox run hit the timestamp false positive; the corrected exact-source five-engine rerun passed.
- Bundler-generated relative Worker and WASM URLs resolve against the current browser page while the Worker continues to reject cross-origin WASM.
- Explicit demo mode exposes a redacted `Transcription.Transcribe` route independently from `Tooling.ExecuteTool`; configured HTTP profiles remain on their configured transport even when demo environment flags are present.
- The hosted Assistant check waits for a real AudioWorklet audio frame, observes native browser capture APIs, verifies exact same-origin Worker/WASM/worklet assets by MIME type and content signature, completes a deterministic demo turn, and checks DOM/storage/console/request-body redaction.
- Runtime role remains persisted dynamic profile state. No environment variable, APK/build flavor, platform, transport, or demo flag selects a role, and local browser speech-pack execution flags remain disabled.

## Fresh verification

- `pnpm --dir packages/aurora-voice-web typecheck` — passed.
- `pnpm --filter @aurora/voice-web run build` — passed, including Rust/WASM and Worker artifacts.
- Focused model/storage Vitest — 3 files, 42/42 passed.
- Full `@aurora/voice-web` Vitest — 12 files, 127/127 passed.
- Browser model storage Playwright — 18/18 across Chromium, Firefox, and WebKit.
- Production Worker/WASM voice Playwright — 35/35 across Chromium, Firefox, WebKit, Android Chrome emulation, and Mobile Safari emulation.
- Real-browser API Playwright — 2/2 across desktop Chromium and mobile Chromium emulation.
- Full `@aurora/client` Vitest — 60 files, 687/687 passed; the focused generated-speech client rerun passed 6/6 after adding the negative `Tooling.ExecuteTool` separation assertion.
- Full `@aurora/web` Vitest — 15 files, 66/66 passed; typecheck and Next production build passed with 24/24 static pages.
- `pnpm --filter @aurora/ui typecheck` and `pnpm --filter @aurora/ui run build` — passed.
- Hosted browser-voice UI Vitest through the normal package configuration — 39/39 passed.
- Full `@aurora/ui` Vitest — 67 files, 701/701 passed; the deterministic accessibility/responsive/visual gate passed 12/12 across Assistant, Admin, and Settings viewports.
- Hosted Next Assistant browser-voice Playwright — 1/1 passed in `chromium-hosted-assistant` at `2026-08-11T11:11:36.824Z`. It uses Chromium fake media through native `getUserMedia`, `AudioContext`, and `AudioWorklet`, with built `@aurora/voice-web` Worker/WASM assets and explicit demo transport. This is not a production-server, physical-microphone, OS permission-prompt, Android-device, acoustic-recognition, or local-browser-STT check.
- `git diff --check` and staged diff checks — passed.
- Independent security, runtime-role, URL architecture, code, hosted-gate, visual, and RAC-state reviews found no blocker. The screenshot shows a completed turn with no internal tool-execution/debug wording or layout overflow; the Next development indicator partially overlays the account chip and is non-blocking test-environment chrome.
- GitNexus staged change detection reported 17 files, 154 indexed changed symbols, 11 affected processes, and high risk because large UI/runtime files were touched. The `createAuroraWebClient`, `AppShell`, `MockAuroraTransport`, and Worker URL call graphs were reviewed against the full test matrix before commit; no blocker remained.

## Bounded scope and remaining gates

- RAC-21 and RAC-23 remain `pass`; RAC-24 and RAC-26 retain their existing `pass` verdicts.
- RAC-22 remains `partial`: browser automation now includes deterministic Worker/WASM PCM plus one hosted Assistant Chromium fake-media `getUserMedia`/AudioWorklet demo turn; it does not prove real microphone capture, acoustic behavior, actual mobile browsers, OS permission prompts, local browser recognition, or physical devices.
- RAC-25 remains `partial`: no production caller currently invokes `installVerifiedBrowserModelPack`; an approved production pack, end-to-end verified-pack offline reuse, signing, final Android/iOS artifact hashes, SBOM/license tooling, and external release evidence remain open.
- ADB to the requested Waydroid endpoint `192.168.240.112:5555` returns `No route to host`; there is no connected ADB device or MobileMCP surface in this runtime. No current-source Waydroid UI, microphone, navigation, or screenshot claim is made.
- OS suspension/background behavior, physical ARM64/iOS evidence, endurance, battery, thermal, and store/distribution gates remain open.

The earlier `Tooling.ExecuteTool` work belongs to RAC-27 only. It is a bounded reverse-RPC/backpressure/authentication canary for the shared WebRTC DataChannel used by voice traffic; it is not a TTS/STT/VAD/KWS dependency and is not part of this Phase 7 implementation checkpoint. The current demo speech test explicitly proves the focused transcription action is indexed under `Transcription.Transcribe`, not `Tooling.ExecuteTool`.
