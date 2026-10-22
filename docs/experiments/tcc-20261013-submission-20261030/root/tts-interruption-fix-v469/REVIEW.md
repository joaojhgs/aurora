# V469 bounded independent TTS interruption source review

2026-10-15 UTC. **APPROVE the exact Root-corrected two-file integration, not the original shared-runtime cancellation addition.** Source inspection/hash/diff only; no imports/tests/runtime/build/model/browser/network/device/Orca operations, canonical/index/goals/vault edits or agents. This report is the sole owned write.

Final canonical source SHA256 `e5caa61b1158946b4e9f0d274a898c3e2c6b538cff5b4aef941d474ee3a08745`; final test `a176e81d7a45ae511bb36183d19620d9ece8598fabd9b8c3680da39f5268635f`. Original private candidate source `504f3c5a53949579d0c573e89fbf57e42b41550e348ee9e87916287121faccc2`, test `b86b7d2e10c6d6e2494a3bb47ef185364da77adcefbb0b3875d6d1243e0ffc16`, patch `089b55e5ee6ed75619acf0ed66522b67b3de42754e85af954ae9f999f5917982` remain historical. Direct comparison confirms Root removed only the new interruption runtime.cancel await and its corresponding test expectation.

## Exact main-path decision

Actual `use-assistant-capture-controller.ts:179` invokes interruption with void, then enters browser.startBrowserVoiceCapture. `use-assistant-browser-capture.ts`'s cancelBrowserVoiceRuntime forwards to the same cached runtime.cancel, not a TTS-only operation. Actual runtime.cancel can cancel capture/pending turn/STT/TTS and emit session_cancelled; its asynchronous worker acknowledgement/event may overlap the new start even though its session-retirement guards protect exact newer sessions. It should not be added as an unawaited shared-runtime side effect to this TTS-only interruption seam. This is a source ownership/concurrency concern, not proof of any prior microphone startup cause.

Root's minimal removal avoids that overlap without modifying the capture caller or introducing a third path. The existing explicit stopReadAloud runtime cancellation is retained for its original operation. The remaining interruption actions invalidate synthesis playback generation, clear the speaking identity, stop/revoke hook-owned active and queued audio, and cancel browser speech synchronously before the first await/server TTS-only cancel. Thus the current immediate capture caller retains its behavior without a new browser-runtime cancel. No auth, route, model, permission or capture readiness gate changes occur.

## Intended playback behavior and evidence

Actual active media is paused/released and queued URLs revoked through the existing stopStreamedTtsPlayback utility. The pending browser synthesis token is invalidated, and late SDK read-aloud success checks its captured token plus current speaking message before enqueueing. Late failure after voice interruption sees the cleared speaking message and cannot enter speech-synthesis fallback. Existing sidecar/browser branches also avoid stale status changes. These observations are limited to the intended interruption main flow, not every possible read-aloud interleaving.

Two focused regressions exercise active-plus-queued release and delayed SDK success/failure after interruption, retaining actual browser speech/server TTS cancellation expectations. The removed runtime-cancel expectation correctly follows the minimal safety correction. Reviewer did not run them; Root owns the sole affected test/typecheck validation. No extra case matrix requested.

No actual playback/microphone/native/WebView acceptance, prior capture-cause attribution, full PER286/voice seal or phase-2 permission follows. No remaining material blocker in this exact corrected integration; stop.
