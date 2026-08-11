# PocketTTS native/WASM voice goal capsule

Updated: 2026-08-11T23:48:49Z

## Authority and workflow

- Start a **fresh normal Codex Goal**. Do not resume or invoke OMX Ultragoal.
- The paused normal Goal thread `019fd073-38a1-7801-8d62-31ae70d46580` is superseded for execution because its metadata repeatedly reactivated cancelled work.
- The former live `.omx/ultragoal/` state is inactive and archived under `.omx/archive/ultragoal-ui-integration-20260725/` as provenance only.
- Authoritative requirements: `.omx/plans/pockettts-cross-surface-local-voice-plan.md`.
- Authoritative criterion tracker: `reports/native-voice/native-voice-rac-matrix.json`.
- Fresh-session instructions: `.omx/state/pockettts-native-voice-fresh-session-handoff.md`.
- Historical 829-line capsule: `.omx/archive/pockettts-native-voice-goal-capsule-history-through-20260811.md`. It is provenance, not current state.
- Branch: `feat/ui-multi-platform-integration`.
- Audited implementation baseline: `851f1591be6a4b9e73948fe85dfc43b607d868c1`. Later commits that touch only state/handoff files do not advance implementation.
- No push was performed.

## Authoritative hashes

- Revised plan: `50181a35cd42e12a33f8b6b1b7131a875bcafcb5a9bcc63eac06c4370ef74ea6`
- Replacement attachment: `70b1b5ebb32c6df0e52c119b2bd73adad79c2611433bd33da7391d6e273fe196`
- Root `AGENTS.md`: `815edf86a7500982815ff49610604617f8efd5ea8a923416b458899886523335`
- Tauri `AGENTS.md`: `1d5dfc0cfdc94b4bd33839ad87211941e6518f300ddf4dbec42cdf6a4502108f`
- Tests `AGENTS.md`: `8cde09a1faeb8fc61428b7688cb0d7729ce9062517fb3272acff2afbb8d8ef49`
- Documentation index: `0632076ef092295feebeb39b9e5d4b18af0bf9c26ce4977d57bad107f8497bd0`
- Phase 6 disposition summary: `bd71dfd00089947ed8fa4ed6fa2d63bfeeb1583dc6819e777abec9b4e357066a`
- Phase 6 raw native resource report: `f9a8222e898a40e930107656d858392a10baf16952f2d3de02beef2214e4d3f2`

## Overall verdict

The revised goal is **incomplete**. Preserved Phases 0-3 remain implementation-complete, the bounded Phase 4 architecture/portability gate is independently reverified, and the bounded Phase 5 shared-foundation gate is independently reverified. Phase 6 now has an independent, fresh **disposition-only** verification: it remains partial and withheld because no release-eligible interoperable speech pack exists. Phases 0-3 still have only partial current-head verification, and no revised Phase 6-13 exit gate is fully reverified.

The old estimate that work should resume at Phase 8 was an overclaim. Phases 4 and 5 are closed only for their explicit architecture/portability and shared-foundation scopes. The Phase 6 candidate-pack disposition and bounded Linux resource evidence are now reconciled by `reports/native-voice/phase6-disposition-20260811/`; the phase itself is not complete. Continue at **Phase 7** with every production VAD/KWS/STT/TTS capability false.

RAC totals remain criterion-scoped: **22 pass / 24 partial / 6 withheld / 4 blocked**. A passing RAC does not make its containing phase complete.

## Phase inventory

| Phase | Implementation | Verification | Current truth / missing exit work |
| --- | --- | --- | --- |
| 0 | Complete, preserved baseline | Partial fresh audit | Benchmark/regression scaffolds exist; 147 Python cases passed with 28 environment/asset skips. Broad audio/Piper/PTT/device regression was not freshly rerun. |
| 1 | Complete, preserved baseline | Partial fresh audit | Provider-neutral configuration and provider lifecycle boundaries exist; Redis process-mode cases skipped. |
| 2 | Complete, preserved baseline | Partial fresh audit | Official Python PocketTTS provider exists with lifecycle/cancel/stream tests; live Redis/process proof was not rerun. |
| 3 | Complete, preserved baseline | Strong partial fresh audit | Typed speech contracts, topic constants, routing/security, and generated SDK tests exist; 46 focused SDK cases passed. |
| 4 | Complete architecture freeze | Pass, fresh local with external exclusions | The complete 24-artifact root validates with `verified_local: true`; pinned source identity, Linux native C/Rust probes, Android arm64/x86_64 source builds and `0x4000` alignment, iOS device/simulator slices, split WASM builds, three-browser Worker execution, and native/browser VAD parity all pass. Live desktop CPAL, Apple runtime/signing, physical devices, release packaging, and PocketTTS/Piper activation remain outside this bounded gate and are explicitly withheld or blocked. Durable receipt: `reports/native-voice/phase4-reverify-20260811/`. |
| 5 | Complete shared foundation | Pass, fresh local with later-phase exclusions | Rust 1.88 fmt/clippy and 313 all-target tests pass; 31 wasm32 core tests pass; the 73-file contract generator surface is byte-identical after a second run; eight focused ownership/model-store/detached-turn tests pass; and the production Worker/WASM browser matrix passes 35 cases across five profiles. Live audio, physical platforms, release packaging, and production speech packs remain later gates. Durable receipt: `reports/native-voice/phase5-reverify-20260811/`. |
| 6 | Partial; production capabilities withheld | Pass for fresh disposition only; exit gate remains partial | Candidate signatures, inventories, bounded parity/cancellation, and corrected Linux resource diagnostics pass. VAD/KWS/STT remain non-production Linux x86_64 validation candidates, TTS remains unavailable, no release-eligible interoperable pack exists, and production capability flags remain false. Durable receipt: `reports/native-voice/phase6-disposition-20260811/`. |
| 7 | Partial | Partial | Rust/WASM Worker, AudioWorklet, browser store, lifecycle, and fake-media/emulation gates pass. Real microphone/acoustic/OS-permission, hosted Firefox/WebKit PTT, actual mobile devices, approved packs, installer, and release evidence are missing. |
| 8 | Partial | Partial | Desktop native source, IPC, CPAL/Gateway boundaries, consent/ownership tests, and bounded transport evidence exist. No promoted full UI-closed background turn, complete local-sidecar plus remote-no-sidecar proof, all-route exact-source aggregate, or Windows/macOS/Linux release matrix. |
| 9 | Partial | Partial / blocked | Android FGS, AudioRecord/JNI/Rust ingress, notification/Stop, storage, playback, and static gates exist. Current-source runtime install failed before app launch; physical ARM64/background/endurance/lifecycle/Play evidence is missing. |
| 10 | Partial skeleton; capability withheld | Partial / blocked | Default-assistant services and role guards exist, but no lightweight KWS-to-full-runtime path or full UI-absent assistant turn is proven. |
| 11 | Partial source boundary | Blocked for runtime proof | Swift/Rust lifecycle and fail-closed policy code exists. No Xcode build, simulator run, physical PTT/background endurance, signing, or App Review evidence. |
| 12 | Partial | Partial | Central surface detection, dynamic roles, copy/accessibility, route/profile pieces exist. Model download/recovery/removal, voice management, support export, migration, and end-to-end persistence are incomplete. |
| 13 | Partial static policy | Partial / blocked | Static artifact, rollback, copy, and security gates exist. Signed releases, production updater, SBOM/license inventory, store review, physical endurance, staged rollout, and runtime rollback proof are missing. |

## RAC inventory

- Pass: RAC-02, RAC-03, RAC-04, RAC-05, RAC-07, RAC-09, RAC-10, RAC-13, RAC-14, RAC-16, RAC-17, RAC-18, RAC-21, RAC-23, RAC-24, RAC-26, RAC-29, RAC-42, RAC-46, RAC-47, RAC-48, RAC-55.
- Partial: RAC-01, RAC-06, RAC-08, RAC-11, RAC-12, RAC-19, RAC-20, RAC-22, RAC-25, RAC-27, RAC-30, RAC-31, RAC-33, RAC-34, RAC-38, RAC-39, RAC-45, RAC-49, RAC-50, RAC-51, RAC-52, RAC-53, RAC-54, RAC-56.
- Withheld: RAC-15, RAC-28, RAC-35, RAC-37, RAC-43, RAC-44.
- Blocked: RAC-32, RAC-36, RAC-40, RAC-41.

See the RAC matrix for criterion-level evidence and exact gaps. Do not promote a row without a fresh verifier and durable evidence tied to the current source.

## Fresh audit evidence

| Check | Result |
| --- | --- |
| Preserved Python speech/config/provider/contract slice | 147 passed, 28 skipped; skips were Redis/asset/environment dependent |
| Generated SDK contract/conformance slice | 46 passed |
| Phase 4 artifact manifest | valid; 24 artifacts; three explicit denials; `verified_local: true`; no errors |
| Phase 4 source identity | pinned sherpa archive and commit verified; 5,424-entry source tree SHA-256 `1ec160e660f428bab1c45319893540553dfd26675090c461ce6da1d817754017`; enclosing Git identity suppressed |
| Phase 4 Linux C/Rust probes | STT, VAD, KWS, evidence-only TTS, and one-callback TTS cancellation passed; TTS remains withheld |
| Phase 4 Android cross-build | `arm64-v8a` and `x86_64` source builds passed; every inspected ONNX Runtime/sherpa C/C++/JNI LOAD segment is `0x4000` aligned |
| Phase 4 iOS package slices | device `arm64` and simulator `arm64`+`x86_64` slices present; Xcode/runtime/signing claims remain blocked on Linux |
| Phase 4 browser and parity | Chromium, Firefox, and WebKit Worker VAD/ASR/KWS passed; native plus all three browsers passed the six-case VAD parity matrix below the 32 ms p95 ceiling |
| Rust 1.88 workspace fmt | passed |
| Rust 1.88 workspace clippy with warnings denied | passed |
| Rust 1.88 workspace tests | 313 passed; one opt-in live CPAL test ignored; native sherpa smoke binaries remained feature-gated |
| Phase 5 wasm32 core | 31 passed on `wasm32-unknown-unknown` |
| Phase 5 contract generation | `make check-sdk-backend-contracts` passed; second explicit run left 73 scoped files hash-identical |
| Phase 5 focused foundation | eight ownership, interruption, corruption, revocation, detached PTT/wake, and background-lease tests passed |
| Phase 5 production Worker/WASM | 35 Playwright cases passed across Chromium, Firefox, WebKit, Android Chrome emulation, and Mobile Safari emulation; two real-browser-API cases and 83 focused web cases also passed |
| Phase 6 candidate disposition | Independent verdict PARTIAL: disposition verified, exit gate not complete, no release-eligible interoperable pack, TTS unavailable, and production VAD/KWS/STT/TTS remain false |
| Phase 6 native Linux resources | Corrected harness builds outside the timed interval; three repetitions per VAD/KWS/STT candidate passed declared RSS and RTF ceilings; physical-device claim false and thermal state unavailable |
| Phase 4/6 focused Python tests | 62 passed |
| Voice-web typecheck and unit suite | passed; 151 tests |
| Desktop/Android focused Tauri tests | 16 passed, 13 skipped |
| iOS/Android/rollback/artifact static Tauri slice | 48 passed |
| Release-trust policy | expected block: placeholder updater configuration, missing mobile hashes, and no SBOM/license tooling |
| Static rollback policy | passed, but explicitly reports `runtimeProof: false` |
| Full Tauri UI suite after Node 24 storage setup | 434 passed, 14 skipped |
| Tauri typecheck | passed |

## Mandatory resume order

1. Create a fresh normal Codex Goal using the revised plan and fresh-session handoff.
2. Record the actual branch HEAD and verify the hashes above.
3. Treat Phase 4 as closed only for its bounded architecture/portability scope using `reports/native-voice/phase4-reverify-20260811/`; do not extend that pass to live CPAL, Apple runtime/signing, physical devices, releases, or TTS activation.
4. Treat Phase 5 as closed only for its shared-foundation scope using `reports/native-voice/phase5-reverify-20260811/`; do not extend that pass to hardware, release, or production-pack claims.
5. Treat Phase 6 as **disposition-verified but partial-withheld** using `reports/native-voice/phase6-disposition-20260811/`. Do not describe its candidates as selected, shippable, interoperable, or production-capable, and keep VAD/KWS/STT/TTS false until approved assets and release evidence exist.
6. Continue Phases 7-13 in dependency order, starting with a current-head Phase 7 bounded re-verification. Phase 8 RAC-27 is locally actionable only after the Phase 7 disposition is recorded.

## Non-negotiable product and architecture rules

- Runtime role is persisted dynamic profile state. Never derive it from environment variables, APK/build flavor, platform, transport, sidecar presence, or runtime tier.
- One APK/bundle may act as a thin client or a node according to runtime `roles`.
- `Tooling.ExecuteTool` is only a shared DataChannel regression canary. It is not voice behavior or voice acceptance evidence.
- Pure web remains foreground-only.
- Installed WebViews must not own durable background capture or native model execution after cutover.
- Keep unavailable production speech capabilities false.
- No push unless the user explicitly requests it.

## Environment and evidence transfer

- Waydroid: direct ADB target `192.168.240.112:5555`; use MobileMCP for final navigation, UI, and screenshots.
- Headless Android API 35 emulator/AVD plus Android SDK/ADB for scripted build/install/service checks.
- Rust 1.88.0, Node/pnpm workspace, Python/uv environment.
- Docker or equivalent Mosquitto/coturn services for direct/STUN/TURN reruns.
- macOS/Xcode/iOS simulator and physical iOS hardware for Phase 11/13.
- Physical Android ARM64 hardware for locked-screen, acoustic, thermal, battery, and endurance claims.
- Copy any required `/tmp` evidence named in the fresh-session handoff; it is not transferred by Git.

## Worktree disposition

- Superseded `aurora-p8-remote-nosidecar-e2e`, `aurora-p8-tray-click-e2e`, and `/tmp/aurora-p8-packaged-desktop-live-2f885e36-run` worktrees were removed from the active worktree registry and moved to trash. Do not merge their old-plan changes.
- Remaining RAC/device worktrees contain historical evidence or unadjudicated commits. They are not current authority and must be reviewed before any cherry-pick.
- No native child agent remains active.

## Stop condition for the next session

Do not report the goal complete until every Phase 4-13 exit gate and every advertised-surface RAC is supported by current-source durable evidence, physical/platform gates are satisfied or capability remains withheld, rollback is runtime-proven, and the release matrix matches shipped behavior.
