# Phase 11 iOS native-voice disposition

Recorded: 2026-08-12T03:49:25Z

Verdict: **source-policy verified; runtime exit gate remains BLOCKED/PARTIAL**.

At current source `5040419e7b0bfcb086c599b8a04f704dcfafa10f`, three
native source-policy scripts, three focused native-iOS voice tests, five iOS
thin-bundle tests, and the canonical `ios:policy` preflight pass on Linux.
The boundary remains foreground-only, reports background listening and Siri
replacement as unavailable, and does not compile a runtime role into the iOS
bundle.

This receipt does not prove an Xcode build, simulator run, packaged WKWebView,
physical-device PTT, background endurance, signing, distribution, App Review,
or iOS WebRTC runtime. Those gates require macOS/Xcode and eligible devices.

RAC-41 remains blocked, RAC-42/RAC-46/RAC-47 remain pass, RAC-43/RAC-44
remain withheld, and RAC-45 remains partial. Production VAD, KWS, STT, and TTS
remain false. No status was promoted by this receipt.

`summary.json` is the machine-readable disposition. `checksums.sha256` binds
the plan, Android receipt, iOS policy sources, and this receipt.
