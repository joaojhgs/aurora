# PocketTTS native/WASM voice fresh-session handoff

Updated: 2026-08-11T21:06:01Z

## Start exactly here

1. Start a **new normal Codex Goal**. Do not use or resume OMX Ultragoal.
2. Check out `feat/ui-multi-platform-integration` and record its actual HEAD.
3. Read, in order:
   - `.omx/plans/pockettts-cross-surface-local-voice-plan.md`
   - `.omx/state/pockettts-native-voice-goal-capsule.md`
   - `reports/native-voice/native-voice-rac-matrix.json`
4. Verify the plan SHA-256 is `50181a35cd42e12a33f8b6b1b7131a875bcafcb5a9bcc63eac06c4370ef74ea6`.
5. Treat `851f1591be6a4b9e73948fe85dfc43b607d868c1` as the audited implementation baseline. Subsequent handoff-only commits do not advance implementation.
6. Resume at the earliest unresolved dependency: **Phase 4 artifact/build verification**, not Phase 8.

The old normal Goal thread `019fd073-38a1-7801-8d62-31ae70d46580` is paused and superseded for execution. Its stale metadata repeatedly routed work back into the cancelled plan.

## Cleanup already completed

- `411736b3` reverts superseded old-plan commits `28e5fca8` and `d92f9b85`.
- `59a7d0b6` removes the live `.omx/ultragoal/` control path and archives it under `.omx/archive/ultragoal-ui-integration-20260725/`.
- `851f1591` commits the useful Node 24 Tauri test-storage setup and product-copy assertion; the full Tauri suite passes 434 tests with 14 skips.
- The stale `aurora-p8-remote-nosidecar-e2e`, `aurora-p8-tray-click-e2e`, and `/tmp/aurora-p8-packaged-desktop-live-2f885e36-run` worktrees were removed from the active registry and moved to trash. Do not merge them.
- No push was performed.

## Truth snapshot

- Overall: incomplete.
- Implementation-complete phases: preserved Phases 0-3 only.
- Fully reverified revised phases: none.
- Phase 4: substantial source/history exists, but the complete artifact root is absent; structural validation says `verified_local: false`. Re-open it.
- Phase 5: strong partial implementation; Rust tests pass, but generator second-run, wasm-target, and complete exit evidence were not re-proven.
- Phase 6: partial and deliberately withheld; no production speech pack is shippable and all local VAD/KWS/STT/TTS flags stay false.
- Phases 7-13: partial, withheld, or blocked; see the capsule table.
- RAC totals: 22 pass, 24 partial, 6 withheld, 4 blocked. These are criterion-level results and do not imply phase completion.

## First work in the new Goal

1. Locate or recreate the Phase 4 artifact root containing all 24 manifest-declared sources, packages, models, and license files.
2. Run `uv run python tools/voice-runtime/validate_phase4_manifest.py --artifact-root <path>` and retain its output durably.
3. Reproduce the Phase 4 desktop, Android ARM64/x86_64 with 16 KB alignment, iOS device/simulator, Emscripten/WASM, callback/cancel, and native/WASM parity claims. Do not substitute fixtures for missing real artifacts.
4. Have an independent verifier adjudicate Phase 4 against its exact exit gate.
5. Only after Phase 4 passes, close Phase 5 contract-generation cleanliness, wasm execution, property/model-store, and fake detached-turn exit gates.
6. Reconcile Phase 6. Keep capabilities withheld unless approved packs pass license, provenance, parity, resource, and release gates.
7. Then proceed in dependency order. RAC-27 desktop transport work is locally actionable later; `Tooling.ExecuteTool` remains only a shared transport canary.

## Fresh audit evidence already gathered

- Preserved Python slice: 147 passed, 28 skipped.
- SDK contract/conformance slice: 46 passed.
- Phase 4 manifest: valid structure, 24 artifacts, local artifacts not verified.
- Rust 1.88 fmt/clippy/tests: passed; roughly 313 tests, with live CPAL ignored and sherpa smoke not executed without artifacts/features.
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
