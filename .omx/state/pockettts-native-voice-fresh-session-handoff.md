# PocketTTS Native/WASM Voice Fresh Session Handoff

Updated: 2026-08-11T20:57:05Z

## Start Here

- Start a new normal Codex Goal. Do not use OMX Ultragoal.
- Branch: `feat/ui-multi-platform-integration`
- Current local HEAD before this handoff-state commit: `59a7d0b6ef780b23153caa98210adcd47d349335`
- Remote status at audit time: local branch is ahead of remote and was not pushed.
- Authoritative plan: `.omx/plans/pockettts-cross-surface-local-voice-plan.md`
- Plan SHA-256: `50181a35cd42e12a33f8b6b1b7131a875bcafcb5a9bcc63eac06c4370ef74ea6`
- Replacement attachment SHA-256: `70b1b5ebb32c6df0e52c119b2bd73adad79c2611433bd33da7391d6e273fe196`
- State capsule: `.omx/state/pockettts-native-voice-goal-capsule.md`
- RAC matrix: `reports/native-voice/native-voice-rac-matrix.json`

## Superseded State

- The former TypeScript/WebView Phase 4-9 future plan is cancelled by the revised plan.
- The old live `.omx/ultragoal/` runtime artifact has been removed from the active path and archived under `.omx/archive/ultragoal-ui-integration-20260725/`.
- Do not invoke `omx ultragoal`, resume the old `G009` artifact, or treat archived Ultragoal files as current implementation state.
- Commit `411736b3` reverts the two stale old-plan desktop Phase 8 commits `28e5fca8` and `d92f9b85`. Those reverted changes are not revised-plan progress.
- Commit `59a7d0b6` archives the former live Ultragoal files out of `.omx/ultragoal/` so hook/runtime state cannot reactivate them.

## Current Truth

- Overall status: active remediation, incomplete.
- RAC counts: 22 pass, 24 partial, 6 withheld, 4 blocked.
- Phase 0: complete/preserved.
- Phase 1: complete/preserved.
- Phase 2: complete/preserved.
- Phase 3: complete/preserved.
- Phase 4: complete for scoped architecture/portability evidence; no missing artifact-root claim.
- Phase 5: complete for shared Rust core/testkit/model-store foundation and remote-audio consent boundary; not a full device turn.
- Phase 6: decision-complete as withheld; no production VAD/KWS/STT/TTS pack is selected or shippable.
- Phase 7: bounded partial/external-gates-only; browser Worker/WASM and storage/lifecycle pieces are proven, but real microphone, acoustic, actual-device, hosted Firefox/WebKit PTT, approved production packs, installer, and release evidence remain open.
- Phase 8: incomplete/partial; next locally actionable phase.
- Phase 9: incomplete/partial; Android source/emulator/Waydroid evidence is bounded and not a full Gateway voice turn or physical proof.
- Phase 10: incomplete/withheld; Android assistant role remains disabled pending device/OEM gates.
- Phase 11: incomplete/blocked; iOS physical/simulator/distribution evidence unavailable in this Linux lane.
- Phase 12: incomplete/partial; surface/copy/accessibility pass, model/download/voice-management states incomplete.
- Phase 13: incomplete/partial; signing, SBOM, store review, rollout, rollback, security, and endurance gates remain open.

## Next Work

1. Re-read the revised plan and this handoff.
2. Verify `git status --short`, `git rev-parse HEAD`, and the hashes above.
3. Resume Phase 8 / RAC-27 only after confirming the tracker still matches code and evidence.
4. First repair the RAC-27 post-revocation observation-window harness.
5. Then consolidate exact-source direct/STUN/TURN desktop evidence.
6. Keep `Tooling.ExecuteTool` only as a shared DataChannel regression canary; it is not foreground voice behavior.
7. After Waydroid/MobileMCP is reachable, validate current-source Android UI/navigation/pairing/Gateway voice; earlier Waydroid screenshots are bounded to APK `8fff7af6`.

## Non-Negotiables

- Runtime role is dynamic persisted profile state, never an environment variable, APK flavor, build flavor, platform, transport, sidecar, or runtime-tier derivation.
- Do not promote any RAC or phase without fresh code/evidence reconciliation.
- Keep production VAD/KWS/STT/TTS capability flags false until approved assets and release evidence exist.
- Do not push unless the user explicitly requests it.

## Evidence To Transfer If Needed

- `/tmp/aurora-p7-16c-final/`
- `/tmp/aurora-desktop-rac27-head-control-20260811-stun-0823/report.json`
- `/tmp/aurora-desktop-rac27-head-control-20260811-stun-rerun-0827/report.json`
- `/tmp/aurora-api35-current-source-smoke-20260811T023117Z`

## Environment Needed For Full Validation

- Rust `1.88.0`
- Node and pnpm workspace dependencies
- Android SDK, ADB, and the headless API 35 emulator
- Waydroid reachable at `192.168.240.112:5555`
- MobileMCP tools for final Android UI navigation/screenshots
- Docker or equivalent local Mosquitto/coturn services for RAC-27 direct/STUN/TURN reruns
- macOS/Xcode/iOS simulator plus physical iOS hardware for iOS gates
- Physical Android ARM64 hardware for locked-screen, acoustic, thermal, battery, and endurance gates
