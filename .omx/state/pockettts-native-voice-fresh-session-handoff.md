# PocketTTS native/WASM voice fresh-session handoff

Updated: 2026-08-12T00:11:00Z

## Start exactly here

1. Start a **new normal Codex Goal**. Do not use or resume OMX Ultragoal.
2. Check out `feat/ui-multi-platform-integration` and record its actual HEAD.
3. Read, in order:
   - `.omx/plans/pockettts-cross-surface-local-voice-plan.md`
   - `.omx/state/pockettts-native-voice-goal-capsule.md`
   - `reports/native-voice/native-voice-rac-matrix.json`
4. Verify the plan SHA-256 is `50181a35cd42e12a33f8b6b1b7131a875bcafcb5a9bcc63eac06c4370ef74ea6`.
5. Treat `851f1591be6a4b9e73948fe85dfc43b607d868c1` as the audited implementation baseline. Subsequent handoff-only commits do not advance implementation.
6. Treat Phase 6 as **disposition-verified but partial-withheld** using `reports/native-voice/phase6-disposition-20260811/`.
7. Treat Phase 7 as **disposition-verified but partial** using `reports/native-voice/phase7-reverify-20260812/`. Resume at **Phase 8 / RAC-27** with production VAD/KWS/STT/TTS false. Phase 4 and Phase 5 are closed only for their bounded scopes by `reports/native-voice/phase4-reverify-20260811/` and `reports/native-voice/phase5-reverify-20260811/`.

The old normal Goal thread `019fd073-38a1-7801-8d62-31ae70d46580` is paused and superseded for execution. Its stale metadata repeatedly routed work back into the cancelled plan.

## Cleanup already completed

- `411736b3` reverts superseded old-plan commits `28e5fca8` and `d92f9b85`.
- `59a7d0b6` removes the live `.omx/ultragoal/` control path and archives it under `.omx/archive/ultragoal-ui-integration-20260725/`.
- `851f1591` commits the useful Node 24 Tauri test-storage setup and product-copy assertion; the full Tauri suite passes 434 tests with 14 skips.
- The stale `aurora-p8-remote-nosidecar-e2e`, `aurora-p8-tray-click-e2e`, and `/tmp/aurora-p8-packaged-desktop-live-2f885e36-run` worktrees were removed from the active registry and moved to trash. Do not merge them.
- No push was performed.

## Truth snapshot

- Overall: incomplete.
- Implementation-complete phases: preserved Phases 0-3 plus the bounded Phase 4 architecture freeze and Phase 5 shared foundation.
- Fully reverified revised phase exits: Phase 4 for its bounded architecture/portability scope and Phase 5 for its bounded shared-foundation scope. Phase 6 and Phase 7 have fresh independent bounded disposition verdicts, not completed exit gates.
- Phase 4: complete architecture freeze; the reconstructed 24-artifact root validates with `verified_local: true`, Linux/Android/WASM builds and C/Rust cancellation pass, iOS device/simulator slices are present, and Chromium/Firefox/WebKit plus native VAD parity pass. Live CPAL, Apple runtime/signing, physical-device, release, and TTS activation claims remain excluded.
- Phase 5: complete shared foundation; Rust fmt/clippy plus 313 tests, 31 wasm32 tests, second-run-clean generation across 73 scoped files, eight focused foundation tests, and 35 production Worker/WASM browser cases pass. Hardware, release, and production-pack claims remain excluded.
- Phase 6: disposition-verified, partial, and deliberately withheld. Corrected three-repetition Linux resource diagnostics pass the candidate ceilings, but VAD/KWS/STT remain validation-only, TTS is unavailable, no release-eligible interoperable pack exists, and all production VAD/KWS/STT/TTS flags stay false.
- Phase 7: bounded current-head foreground browser/runtime disposition verified; real microphone/acoustic, actual-device, hosted Firefox/Safari microphone, approved-pack, and release gates remain open.
- Phases 8-13: partial, withheld, or blocked; see the capsule table.
- RAC totals: 22 pass, 24 partial, 6 withheld, 4 blocked. These are criterion-level results and do not imply phase completion.

## First work in the new Goal

1. Verify the Phase 4, Phase 5, and Phase 6 receipts and keep every external exclusion intact.
2. Preserve the Phase 6 independent PARTIAL verdict: disposition verified, exit gate incomplete, no production speech capability enabled.
3. Verify the Phase 7 bounded receipt and keep every fake-media/emulation and external-environment exclusion intact.
4. Resume at Phase 8 / RAC-27, then proceed through Phases 9-13 in dependency order. `Tooling.ExecuteTool` remains only a shared transport canary.

## Fresh audit evidence already gathered

- Preserved Python slice: 147 passed, 28 skipped.
- SDK contract/conformance slice: 46 passed.
- Phase 4 manifest: valid against the complete root, 24 artifacts, three explicit denials, `verified_local: true`, no errors.
- Phase 4 source/build matrix: pinned 5,424-entry sherpa source identity; Linux C/Rust STT/VAD/KWS and evidence-only TTS cancellation; Android arm64/x86_64 source builds with all inspected LOAD segments `0x4000` aligned; iOS device/simulator slices; split WASM builds.
- Phase 4 browser/parity: Chromium, Firefox, and WebKit Worker VAD/ASR/KWS passed; native plus all three browsers passed exact six-case VAD parity below the 32 ms p95 ceiling.
- Phase 5 Rust foundation: fmt/clippy passed; 313 all-target tests passed with one live CPAL test ignored; 31 wasm32 tests passed.
- Phase 5 generation/behavior: the full SDK/backend check passed, a second run kept 73 scoped files hash-identical, and eight focused ownership/store/detached-turn tests passed.
- Phase 5 web execution: 35 production Worker/WASM browser cases passed across five profiles, plus two real-browser-API and 83 focused web cases.
- Phase 6 disposition: independent verdict PARTIAL; candidate trust, signatures, inventories, bounded parity/cancellation, and fail-closed capability policy pass, but no release-eligible interoperable pack or selectable TTS pack exists.
- Phase 6 native resources: after `7372d0fe` moved the Cargo build outside measurement, three repetitions per VAD/KWS/STT candidate passed declared RSS and RTF ceilings. Raw report SHA-256: `f9a8222e898a40e930107656d858392a10baf16952f2d3de02beef2214e4d3f2`; no physical-device or thermal claim.
- Phase 6 durable receipt: `reports/native-voice/phase6-disposition-20260811/`; summary SHA-256 `bd71dfd00089947ed8fa4ed6fa2d63bfeeb1583dc6819e777abec9b4e357066a`.
- Phase 7 durable receipt: `reports/native-voice/phase7-reverify-20260812/`; summary SHA-256 `d3ac6e787c62f65665e64b775b5b54d4fa8e2c76d5ed56b5592ab696be40e16a`. The phase remains partial and production VAD/KWS/STT/TTS remain false.
- Phase 4/6 focused Python tests: 62 passed.
- Voice-web typecheck/tests: passed, 151 tests.
- Focused desktop/Android Tauri slice: 16 passed, 13 skipped.
- iOS/Android/rollback/artifact static slice: 48 passed.
- Full Tauri UI suite: 434 passed, 14 skipped; typecheck passed.
- Release trust: correctly blocked by placeholder updater configuration, missing mobile hashes, and absent SBOM/license tooling.
- Static rollback policy: passed, but runtime rollback proof is false.

## Remaining worktrees: review, do not assume

- `/home/developer/projects/aurora-worktrees/phase8-10-audit-20260809`: unique `5cfbc7c5` is unadjudicated; do not cherry-pick without diff/review.
- `/home/developer/projects/aurora-worktrees/rac27-manifest-timeout-a016`: unique `9db839c3` is an unadjudicated desktop Tooling projection harness change, not voice completion evidence.
- `final-8fff7af6`, `rac27-desktop-gtk-8fff`, `rac27-desktop-live-20260809`, and `rac27-live-79561082` contain historical device/transport evidence or patch-equivalent commits. They are not current state authority.

## Environment/state to transfer

- The session JSON if conversation continuity is desired, but create a new Goal after opening it.
- Waydroid reachable directly at `192.168.240.112:5555` plus MobileMCP for final UI navigation/screenshots.
- Headless API 35 emulator/AVD, Android SDK, and ADB for scripted tests.
- Rust 1.88.0, `uv` Python environment, Node/pnpm workspace dependencies.
- Docker or equivalent Mosquitto/coturn services for direct/STUN/TURN evidence.
- macOS/Xcode/iOS simulator and physical iOS device for Apple gates.
- Physical Android ARM64 device for background/acoustic/thermal/battery/endurance gates.
- If exact historical evidence is needed, copy these non-Git paths separately when present:
  - `/tmp/aurora-p7-16c-final/`
  - `/tmp/aurora-desktop-rac27-head-control-20260811-stun-0823/report.json`
  - `/tmp/aurora-desktop-rac27-head-control-20260811-stun-rerun-0827/report.json`
  - `/tmp/aurora-api35-current-source-smoke-20260811T023117Z`

## Invariants

- Runtime `roles` are dynamic persisted profile state, never environment/build/platform/transport/sidecar-derived.
- One APK or desktop bundle may be a thin client or a node according to those roles.
- Pure web is foreground-only.
- Product UI must not expose engineering/test vocabulary.
- No phase/RAC promotion without current-source durable evidence and independent verification.
- Do not push unless the user explicitly requests it.
