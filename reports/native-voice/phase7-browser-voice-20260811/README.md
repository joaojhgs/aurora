# Phase 7 browser-voice hardening checkpoint

**Status:** Current bounded check

Implementation checkpoint `671605b3` includes the earlier Phase 7 browser model-pack, Worker/WASM, focused push-to-talk, connected-client speech playback, responsive composer, and end-user-copy hardening through `779ce7d8`. It additionally preserves sanitized microphone-start classifications, propagates hosted speech routes without inventing a device target, and fails closed on untrusted browser model-pack asset sources before any fetch or storage mutation. It does not complete Phase 7 or promote any RAC status.

## Accepted evidence

- Browser model-pack fetch and staging accept an `AbortSignal`; cancellation before promotion leaves no new active metadata or promoted blobs.
- Every selected file is verified before promotion begins.
- Immutable manifest-generation keys prevent a failed same-version reinstall from corrupting an already active pack.
- Promotion snapshots active, installed, and manifest metadata; a failed commit restores the prior JSON state and removes only newly promoted blobs.
- Cleanup failures are surfaced while retaining the primary failure classification. Maximum-length pack IDs remain within the browser host key limit, and `removePackData(packId)` still groups every generation correctly.
- Browser model-pack manifests reject invalid asset URL fields. Install accepts same-origin HTTPS, explicitly trusted HTTPS origins, and relative URLs resolved against an explicit trusted base; cleartext loopback is nonproduction opt-in only, unsafe schemes fail before fetch, and the default downloader rejects redirects. Custom fetch injection is documented as a trusted caller-owned/test transport override.
- Focus-limited browser surfaces render `Wake while open`; `Wake and background` remains reserved for a future surface that can actually sustain background wake behavior.
- Browser privacy assertions exclude non-sensitive timestamps before checking that PCM/transcript markers are absent. An initial Firefox run hit the timestamp false positive; the corrected exact-source five-engine rerun passed.
- Bundler-generated relative Worker and WASM URLs resolve against the current browser page while the Worker continues to reject cross-origin WASM.
- Explicit demo mode exposes a redacted `Transcription.Transcribe` route independently from `Tooling.ExecuteTool`; configured HTTP profiles remain on their configured transport even when demo environment flags are present.
- The hosted Assistant check waits for a real AudioWorklet audio frame, observes native browser capture APIs, verifies exact same-origin Worker/WASM/worklet assets by MIME type and content signature, completes a deterministic demo turn, and checks DOM/storage/console/request-body redaction.
- Cancellation remains authoritative while `getUserMedia` or the PCM source is still starting: late streams are stopped before an audio context can become active, and stale cleanup cannot clear a newer session.
- Stopping connected-client read-aloud pauses playback, detaches handlers, clears the active source, and revokes each Blob URL exactly once. Desktop-local server-owned playback remains separate.
- The composer gives attach, connected-voice access, prompt, microphone, and send controls explicit columns; the production-hosted check proves they remain on one row without horizontal overflow at desktop and a 390x844 viewport.
- Microphone failures render sanitized recovery guidance beside the composer, and voice privacy copy no longer exposes backend, retention-policy, or TTL wording.
- Hosted startup retains server-provided speech routes while the live shell is loading, then switches to the live snapshot. Remote STT/TTS policies preserve exact provider, peer, and service identity.
- Routes that require an explicit device selection do not silently choose the first connected device. Hosted browser, desktop-thin native, native-mobile, and read-aloud entry points fail closed with product-facing guidance before capture or synthesis starts; explicitly selected provider identity remains supported.
- Runtime role remains persisted dynamic profile state. No environment variable, APK/build flavor, platform, transport, or demo flag selects a role, and local browser speech-pack execution flags remain disabled.

## Fresh verification

- `pnpm --dir packages/aurora-voice-web typecheck` — passed.
- `pnpm --filter @aurora/voice-web run build` — passed, including Rust/WASM and Worker artifacts.
- Focused model/storage Vitest — 3 files, 54/54 passed.
- Full `@aurora/voice-web` Vitest — 12 files, 139/139 passed.
- Browser model storage Playwright — 18/18 across Chromium, Firefox, and WebKit.
- Production Worker/WASM voice Playwright — 35/35 across Chromium, Firefox, WebKit, Android Chrome emulation, and Mobile Safari emulation.
- Real-browser API Playwright — 2/2 across desktop Chromium and mobile Chromium emulation.
- Full `@aurora/client` Vitest — 60 files, 687/687 passed; the focused selector boundary passed 4/4 and emits identity-only selector fields.
- Full `@aurora/web` Vitest — 17 files, 68/68 passed; typecheck and Next production build passed with 24/24 static pages.
- `pnpm --filter @aurora/ui typecheck` and `pnpm --filter @aurora/ui run build` — passed.
- Focused browser-voice UI Vitest — 52/52 passed, including hosted, desktop-thin native, native-mobile, read-aloud, sanitized microphone-start failures, exact route identity, consent invalidation, and selector-required fail-closed cases.
- Full `@aurora/ui` Vitest — 67 files, 715/715 passed; the deterministic accessibility/responsive/visual cases remain included and passing.
- Hosted Next Assistant browser-voice Playwright — 1/1 passed in `chromium-hosted-assistant` at `2026-08-11T13:38:30.584Z` after `next build` and `next start`. It uses Chromium fake media through native `getUserMedia`, `AudioContext`, and `AudioWorklet`, with built `@aurora/voice-web` Worker/WASM assets and explicit demo transport. Fresh desktop and 390x844 screenshots passed direct alignment, clipping, wording, and overflow inspection. This is not a physical-microphone, OS permission-prompt, Android-device, acoustic-recognition, or local-browser-STT check.
- `git diff --check` and staged diff checks — passed.
- Two independent reviews of the final route commit found no blocker after rejecting and repairing three fail-open/loading defects. Both fresh screenshots show a completed turn with no internal tool-execution/debug wording, clipping, wrapping, or horizontal overflow.
- The browser asset-source policy was independently rejected once after it broke the real-browser offline-reopen flow, repaired, then approved. Fresh integrated verification passes focused 30/30, full package 139/139, typecheck/build, and browser storage 18/18 across Chromium, Firefox, and WebKit.
- GitNexus reindexed the repository before the source-policy slice to 52,077 nodes, 124,517 edges, and 300 flows. Staged detection for the three-file source-policy slice reported medium risk across four expected install/verification flows; all affected flows pass targeted, full-package, and real-browser storage tests. The earlier seven-file route slice also reported medium risk across four hosted page/client flows, all covered by targeted and full tests.

## Bounded scope and remaining gates

- RAC-21 and RAC-23 remain `pass`; RAC-24 and RAC-26 retain their existing `pass` verdicts.
- RAC-22 remains `partial`: browser automation includes deterministic Worker/WASM PCM, real browser capture APIs with fake media, route/consent behavior across hosted and native-owner adapters, and one production-built hosted Assistant turn; it does not prove a real microphone, acoustic behavior, actual mobile browsers, OS permission prompts, local browser recognition, or physical devices.
- RAC-25 remains `partial`: no approved signed/licensed production VAD/KWS/STT/TTS pack exists and no production caller invokes `installVerifiedBrowserModelPack`; end-to-end verified-pack offline reuse, signing, final Android/iOS artifact hashes, SBOM/license tooling, and external release evidence remain open. Production local-engine booleans correctly remain false.
- At `2026-08-11T13:40:05Z`, `waydroid0` was link-down and ADB listed no device, so no MobileMCP surface was available. A separate API 35 QEMU software-TCG attempt reached partial ADB and stopped boot animation, but never set `sys.boot_completed`, disappeared before package readiness/tests, and was cleaned up. These are environment/device blocks, not Aurora application failures; no current-source Waydroid UI, microphone, navigation, or screenshot claim is made.
- OS suspension/background behavior, physical ARM64/iOS evidence, endurance, battery, thermal, and store/distribution gates remain open.

The earlier `Tooling.ExecuteTool` work belongs to RAC-27 only. The previous goal run had advanced into that later shared-transport gate before the full inventory reset the active work to the earliest incomplete phase. It is a bounded reverse-RPC/backpressure/authentication canary for the shared WebRTC DataChannel, not a speech implementation dependency or a remnant production bug. Browser speech targets `Transcription.Transcribe`, `WakeWord.*`, and `TTS.*`; the current tests explicitly prove the focused transcription action does not route through `Tooling.ExecuteTool`.
