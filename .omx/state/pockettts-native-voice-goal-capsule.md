# PocketTTS native/WASM voice goal capsule

Updated: 2026-08-10T22:36:30Z

## Goal identity and authority

- Active resumed Codex Goal thread: `019fd073-38a1-7801-8d62-31ae70d46580`
- Resume authority: on 2026-08-08 the user explicitly resumed this thread and overrode the older handoff instruction not to resume it; the strict audited phase/RAC state below remains mandatory
- Objective attachment: `pasted-text-1.txt` with SHA-256 `70b1b5ebb32c6df0e52c119b2bd73adad79c2611433bd33da7391d6e273fe196`; the complete authoritative plan is tracked in the repository, but the paused Codex Goal metadata still names the original absolute attachment path, so copy or remap this attachment with the session
- Authoritative plan: `.omx/plans/pockettts-cross-surface-local-voice-plan.md`
- Transfer/resume branch: `feat/ui-multi-platform-integration` (use the fetched remote tip as the new integration baseline)
- Historical integration branch: `integrate/pockettts-p8-python-handoff-staging-20260807` at `f8cc01d8`
- Transfer integration checkpoint before this final state refresh: `97f7e812`; it merges the audited lineage onto remote base `a59cae0a` and includes RAC-27 as `54b395a9`/`4b07352c`, RAC-48 hardening as `39257f30`, RAC-25 groundwork as `a49a17e9`, and the repository-native handoff state
- Stopped pre-replacement baseline: `961120a443af48bf3c2254121bba333c5356f7c8`
- Preserved Phase 0-3 baseline named by the plan: `5a8a33dc5392c3b50b1b4860c5f90230f96e9cdc`
- Audited code/evidence checkpoint: `66d71c88` on `integrate/pockettts-p8-python-handoff-staging-20260807`
- Tracked RAC audit commit: `799c4ad1`; pointer commit: `c503a89e`; active-remediation state commit: `b5c91401`; consent correction: `3202af9d`; device-evidence reconciliation checkpoint: `c32c2e2c`; interop-gate correction checkpoint: `deecdc36`; dynamic-role onboarding checkpoint: `09455cca`; web-thin explicit-role checkpoint: `091add3a`; RAC24 lifecycle checkpoint: `af425907`; resume-matrix checkpoint: `770a9fd7`; Mobile-MCP evidence-truth correction: `f2ef2274`; RAC30 scope correction: `18811e46`; all-invite dynamic-role save guard: `93473814`; RAC26 persisted-fallback checkpoint: `16f58c8e`; surface role-neutral checkpoint: `73b1039f` and `b48040a4`; native persisted-role checkpoint: `3ac40ba1`; strict native role/tier checkpoint: `06e2f081`; RAC tracker checkpoint: `37a506dc`; disabled speech fixture checkpoint: `a1e39b74`; audited-lineage checkpoint: `f8cc01d8`; transfer integration checkpoint: `97f7e812`
- Canonical implementation-state records: this capsule and `reports/native-voice/native-voice-rac-matrix.json` on `feat/ui-multi-platform-integration`
- Latest local feature-branch checkpoint: `f19be7f4` adds timeout hardening for the static release trust policy guard tests on top of `bae111cb`'s release trust gate and rollback-policy compatibility fix. These commits are local only and have not been pushed.
- Superseded artifacts: `.omx/plans/pockettts-ultrawork-goal-prompt.md` and the old integration-worktree `pockettts-goal-capsule.md`

## Authoritative hashes

- Revised plan: `50181a35cd42e12a33f8b6b1b7131a875bcafcb5a9bcc63eac06c4370ef74ea6`
- Replacement handoff attachment: `70b1b5ebb32c6df0e52c119b2bd73adad79c2611433bd33da7391d6e273fe196`
- Root `AGENTS.md`: `0ca56b786c02e8981b03ff2a906a79105679c674421febe402dfb195623c752e`
- Tauri `AGENTS.md`: `1d5dfc0cfdc94b4bd33839ad87211941e6518f300ddf4dbec42cdf6a4502108f`
- Tests `AGENTS.md`: `8cde09a1faeb8fc61428b7688cb0d7729ce9062517fb3272acff2afbb8d8ef49`

## Strict inventory override and resume gate

This section is the authoritative resume state from the 2026-08-08 strict code-and-evidence audit, reconciled through integration checkpoint `f8cc01d8` plus the fresh Phase 7 and Phase 8 status adjudication recorded below. Later sections retain chronological evidence and provenance only; they do not override this verdict. In particular, any older chronological statement that labels the prior Waydroid navigation as Mobile-MCP evidence is superseded: the persisted report records Mobile-MCP as unavailable and direct ADB as the fallback.

- Overall goal verdict: **active remediation and incomplete**. It must not advance out of audited dependency order or rely on earlier completion labels.
- Audited phase verdict: Phases 0-4 and the Phase 5 shared-core/testkit plus remote-audio consent boundary are complete for their scoped source-level claims. The Phase 6 disposition decision is complete as withheld; it enables no production speech capability. Current device behavior and Phases 7-13 remain gated below.
- Phase 4 CPAL provenance is reconciled and independently approved at integration checkpoint `9230b6a9`: `tools/voice-runtime/phase4_manifest.json`, the validator, documentation, and `Cargo.lock` now agree on the selected CPAL `0.18.1` crates.io artifact. Local artifact-root verification remains unclaimed because no complete artifact root is present.
- The Phase 6 disposition is independently approved as withheld: every production VAD, KWS, STT, and TTS capability remains false and no shippable production pack is selected. Phases 7-13 remain incomplete, partial, withheld, or externally blocked as detailed below.
- Corrected RAC verdict after source-level consent approval and strict Phase 7/8 adjudication: **22 pass, 24 partial, 6 withheld, 4 blocked**. RAC-24 is pass after the real browser page-lifecycle adapter and Playwright lifecycle matrix landed at `af425907`. RAC-26 is pass at `16f58c8e`: all five sanitized non-ready local speech-pack states restore from saved browser runtime state while every local speech engine remains disabled, authorized remote STT/TTS selection is preserved, and connected-audio consent still fails closed. RAC-25 remains partial: approved-as-partial WebCrypto groundwork `6db60a0a` re-verifies signed manifest JSON, receipt metadata, and promoted hashes with a zero-network reload proof while keeping the hot WASM under the recorded gate; later feature commits add release-hash trust, duplicate file-id rejection, and local static release-trust workflow enforcement at `bae111cb`, but production signing material, store/release artifact hashes, SBOM/license inventory, and final release evidence remain open. RAC-27 remains partial after deterministic saved-role route-matrix harness commits `327937d0` and `136da800` because the packaged all-route live desktop run was interrupted during its cold native compile before WebDriver execution. RAC-30 is partial because focused installed-desktop suppression is tested but the full installed-desktop cutover and UI-closed background turn are not. RAC-50 remains partial: KVM-backed API35 packaged Android smoke passes, and Waydroid direct-ADB validation of APK SHA-256 `a9b53e120dfc11a9bfaa019d15c9f62010a940bf7b368f92d0e2486c00700457` proves cold launch, visible onboarding, and one navigation step. That APK was built before `36009965` and its exact source SHA was not recorded; final-source rebuild/install provenance, Mobile-MCP, pairing, and a complete Gateway/UI voice turn remain open.
- Runtime role is dynamic profile state. It is never selected by environment variables, APK flavor, compiled artifact, platform surface, or transport mode; one APK may operate as a thin client managing a server or as a node itself.
- All invite-backed Tauri save surfaces now pass through one reviewed guard at `93473814`, which writes `remote-console` and `none` before runtime-profile reconstruction; explicit device-sharing flows remain the only route to `mesh-node`.
- Dynamic-role defect repair is integrated through `06e2f081` and tracked at `37a506dc`. Surface defaults no longer assign `mesh-node` or a runtime tier from sidecar/platform signals, desktop-local capable Tauri shells stay `remote-console`/`none` until onboarding saves a runtime profile, and desktop native voice resolves persisted role/tier before sidecar availability. Remote-console and legacy remote profiles stay remote even when a sidecar is running; local sidecar voice requires an active persisted `mesh-node` profile with `runtimeTier` `python-full` and an available sidecar; lightweight mesh-node, absent, or invalid role state fails closed. This closes the audited role-inference defect but does not by itself advance RAC-27 or Phase 8.
- Resume order is mandatory from the local `feat/ui-multi-platform-integration` tip `f19be7f4`: (1) retain RAC-25 as partial while production signing material, final artifact hashes, SBOM/license tooling, and external release evidence remain open; (2) finish RAC-27's packaged all-route desktop run, then continue Phase 8 onward in dependency order with the dynamic-role invariant preserved; (3) rerun direct/STUN/TURN on the Docker-backed interop stack; and (4) rebuild the final APK from a recorded clean source SHA before repeating Waydroid install, onboarding, pairing, navigation, screenshots, and complete Gateway/UI validation. Do not promote blocked physical/platform claims.
- Forward-work gate: do not promote a phase or RAC status until a fresh independent verifier confirms the code, current tests, and persisted evidence agree.

### 2026-08-10 current feature-branch refresh

- Current code evidence baseline after this corrective update: `f19be7f4` on `feat/ui-multi-platform-integration`; the branch includes accepted iOS start hardening, Android WebRTC harness hardening, voice-clone tombstone scrubbing, RAC-25 release-trust hardening plus the static release trust workflow gate and timeout-hardened focused guard tests, RAC-54 HTTP rollback role preservation, RAC-51 fail-closed credential-storage hardening, Android client bundle initialization, dynamic role preservation across disabled rollout gates, mesh-role/runtime-tier decoupling, refreshed goal state, refreshed GitNexus guidance, bounded Waydroid launch evidence, focused iOS peer-credential validation before reuse, and duplicate GitNexus legacy-skill cleanup.
- Preserved generated schema dirt has been restored exactly in the primary checkout from `/home/developer/projects/aurora-worktrees/phase8-10-audit-20260809`: `apps/aurora-tauri/src-tauri/gen/schemas/acl-manifests.json` has blob hash `56f33c324c83876e7e1f6700a44177fe5a13d74b` and must remain unstaged until an authoritative schema regeneration replaces it. Apart from that intentional dirt, the primary feature checkout currently contains only this corrective evidence change.
- RAC-25 status remains partial, not pass. Integrated evidence now includes release-hash trust with caller-supplied trusted keys/hash, duplicate file-id rejection, `pnpm --filter @aurora/voice-web typecheck`, focused `browser-model-pack.test.ts` `9/9`, package build with Worker/WASM assets, full `@aurora/voice-web` tests `110/110`, local static release-trust workflow enforcement at `bae111cb`, and timeout-hardened focused guard tests at `f19be7f4`. Fresh primary-checkout validation passed focused release-trust Vitest `68/68`, Tauri UI typecheck, trust policy package script with expected release blocking only for placeholder updater config plus unsupported Android/iOS artifact hashes and SBOM/license tooling, and GitNexus staged detection reporting one changed test file, zero affected processes, and low risk. Broader integration-worktree validation passed the same focused release-trust Vitest `68/68`, Tauri UI typecheck, and the same fail-closed trust policy package script. Production signing material, final artifact hashes, SBOM/license tooling, and external release evidence remain open.
- RAC-51 status remains partial. Source hardening now deletes corrupt, expired, or semantically invalid Rust/Android/iOS stored peer credentials before reuse, including iOS loaded-record validation before reconnect reuse. Primary validation passed `cargo +1.88.0 fmt --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml --check`, `git diff --check`, `pnpm --filter @aurora/tauri-ui exec vitest run src/secure-storage-policy.test.ts src/android-voice-route-policy.test.ts --environment node` (`19/19`), the later focused policy/bundle tests (`33/33`), and `pnpm --filter @aurora/tauri-ui exec vitest run src/secure-storage-policy.test.ts --environment node` (`12/12`) after the iOS validation refinement. The focused Rust unit compile did not complete under concurrent Android/desktop build pressure, so full runtime keychain/background proof remains open.
- RAC-54 status remains partial. The rejected role-withdrawal work is superseded: `13d45c9d` preserves the explicitly requested/persisted `mesh-node` role during WebRTC-preferred HTTP rollback and withdraws only WebRTC-dependent readiness. Follow-up `a69034f5` keeps `activeNodeRole` equal to the persisted/requested role even when `mesh_node_runtime_v1` is disabled, and `36009965` prevents the surface `runtimeTier` from being inferred from that role while the mesh implementation is disabled. Fresh focused UI validation on 2026-08-10 passed `pnpm --filter @aurora/ui exec vitest run tests/web-thin-runtime.test.tsx tests/platform-surface.test.ts --environment jsdom` (`79/79`) and `pnpm --filter @aurora/ui typecheck`, while end-to-end rollback/restore evidence remains open.
- RAC-27 and Android final validation remain pending. No accepted packaged desktop all-route WebDriver evidence, Mobile-MCP-driven navigation proof, pairing proof, or complete Gateway/UI voice turn has landed on the feature branch. Bounded Waydroid ADB evidence now exists under `reports/native-voice/android-waydroid-20260810/`: direct serial `192.168.240.112:5555`, manufacturer `Waydroid`, `dev.aurora.desktop` version `0.1.0`, cold launch/focus of `dev.aurora.desktop/.MainActivity`, role choice persisted as "Make this device available", transition to invite setup, valid screenshots/XML, and redacted startup logcat. The exercised APK hash is recorded above, but no committed install transcript ties it to a clean install and its exact source SHA is unrecorded. This is launch/onboarding evidence only; it is not final-build, Mobile-MCP, pairing, full navigation, or voice-turn proof.

## Audited phase status

- Phase 0: complete/preserved.
- Phase 1: complete/preserved.
- Phase 2: complete/preserved.
- Phase 3: complete/preserved and contract/security hardening retained.
- Phase 4: audit-clean for CPAL provenance at `9230b6a9`. The architecture decision, selected CPAL `0.18.1` manifest entry, validator, documentation, and lockfile now agree and were independently approved; no local artifact-root verification is claimed.
- Phase 5: complete for the shared Rust core, bounded ports, ownership/lifecycle semantics, model-store primitives, testkit foundation, and remote-audio consent boundary. This is not proof of a full end-user/device voice turn.
- Phase 6: disposition decision complete/withheld. Candidate adapters and diagnostic parity work exist, but every production VAD/KWS/STT/TTS capability remains false and no shippable production pack is selected; this is not a production capability-completion claim.
- Phase 7: incomplete/partial. Browser Worker/WASM, storage foundations, page lifecycle invalidation, and the complete persisted non-ready remote-fallback matrix are proven; production pack, real microphone/acoustic, physical mobile, and verified-pack offline reuse under the unchanged production WASM budget remain open.
- Phase 8: incomplete/partial. Desktop/native transport, capture/playback, packaging, and ownership slices exist, but the full cross-platform lifecycle and signed release matrix is not proven.
- Phase 9: incomplete/partial. Android native capture and foreground-service plumbing work in bounded Waydroid evidence, but there is no complete Gateway voice turn, physical ARM64 acoustic/locked-screen/endurance proof, or Play release evidence.
- Phase 10: incomplete/withheld. Android assistant-role plumbing is optional and disabled; role-held full-turn, resource, OEM, and physical-device evidence are absent.
- Phase 11: incomplete/blocked. iOS source boundaries exist, but the native transport is disabled and build, simulator, physical-device, lifecycle, and distribution evidence are unavailable in this lane.
- Phase 12: incomplete/partial. Surface detection, copy, and accessibility contracts pass, while model/download/voice-management mutations and truthful readiness transitions are not fully implemented or proven.
- Phase 13: incomplete/partial. Some local artifact/policy checks pass, but signing, SBOM, store review, security review, rollback, staged rollout, and physical endurance gates remain open or external.

## Current wave and ownership

- Phase 5 consent re-audit: `3202af9d` keys focused capture to the selected transcription route, excludes TTS from microphone-egress consent, preserves route-keyed revocation, and keeps local selection at `remoteAudioConsent: false`. Full UI typecheck plus 667 tests and full Tauri typecheck plus 314 tests passed. Three independent reviewers returned APPROVE with zero must-fix findings. A fresh x86_64 Android client APK built and artifact verification passed; the installed Waydroid APK was independently hash-matched, while persisted UI evidence proves only direct-ADB role choice and invite onboarding because Mobile-MCP was unavailable. Pairing, actual Mobile-MCP navigation, and the Gateway voice turn remain open. The original API35 headless failure is an emulator-provider defect: the same renderer SIGTRAP reproduces in the stock WebView shell, so a known-good emulator is required for the packaged frontend gate.
- Phase 6 truth re-audit: `4139eabd` is independently approved as a decision-complete withheld disposition; focused Phase 6 tests pass 27/27 and documentation checks pass. No production speech capability or release index was promoted.
- RAC reconciliation: the current evidence is **22 pass / 24 partial / 6 withheld / 4 blocked** after RAC24 lifecycle closure at `af425907`, Mobile-MCP evidence correction at `f2ef2274`, RAC30 full-cutover scope correction at `18811e46`, RAC26 persisted-fallback closure at `16f58c8e`, and dynamic-role invariant repair through `06e2f081`; the tracked matrix is current at `37a506dc` and the code checkpoint is `06e2f081`. Prior APK build/verify, exact installed-APK hash matching, and direct-ADB Waydroid onboarding inspection remain valid historical evidence. Actual Mobile-MCP readiness is confirmed for online Waydroid device `192.168.240.112:5555` (Android 13, 1080x2400, Aurora package visible), but no final UI validation is claimed before a fresh integrated APK. KVM access is repaired and `/home/developer/Android/Sdk/emulator/emulator -accel-check` reports usable KVM. The rootable Google APIs API35 x86_64 AVD `emulator-5560` is healthy and the maintained packaged Aurora smoke passes `1 passed` in 160.69 seconds with `dev.aurora.desktop` version 0.1.0 installed; log `/tmp/aurora-headless-5560-android-smoke-kvm-20260809-030101.log`. This is packaged smoke evidence, not a Gateway voice turn or physical-device claim. The real MQTT/TURN stack remains available only through `DOCKER_HOST=unix:///run/host/tmp/distrobox-docker.sock`; no fresh direct/STUN/TURN pass exists after the KVM repair. Fresh Docker-backed interop therefore remains open alongside fresh-APK Mobile-MCP navigation, Waydroid pairing, the complete Gateway/UI voice turn, and the installed-desktop background cutover. Temporary dummy/direct-only wrapper attempts are excluded from evidence.
- Dynamic-role invariant verification through `f8cc01d8`: `cargo +1.88.0 fmt --manifest-path rust/Cargo.toml --all --check`; `cargo +1.88.0 test --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml native_voice --locked` (22 native voice tests); `pnpm exec vitest run src/desktop-thin-profile.test.ts src/native-voice.test.ts src/android-voice-route-policy.test.ts src/aurora-client.test.tsx --environment jsdom` (115 tests); `pnpm --filter @aurora/ui exec vitest run tests/platform-surface.test.ts tests/web-thin-runtime.test.tsx --environment jsdom` (78 tests); `pnpm --filter @aurora/tauri-ui typecheck`; `pnpm --filter @aurora/ui typecheck`; `pnpm exec vitest run src/desktop-thin-profile.test.ts src/aurora-client.test.tsx --environment jsdom` (100 tests); and focused follow-up `pnpm exec vitest run src/desktop-thin-profile.test.ts --environment jsdom` (38 tests) pass. The strict native role/tier refinement keeps remote-console and legacy remote profiles remote with a running sidecar, rejects lightweight mesh-node as local, keeps disabled local-speech test fixtures aligned to production `local_speech_disabled` state, and removes obsolete `VITE_AURORA_RUNTIME_MODE` role stubs from the Tauri profile tests.
- RAC-25 verifier/budget adjudication: the unchanged production WASM gate is 146,432 bytes; the hot core remained under that gate during the original verifier review, and the rejected Rust verifier branch remains excluded. Approved-as-partial commit `6db60a0a` added browser WebCrypto Ed25519 verification with no verifier injection, signed manifest persistence, promoted-hash re-verification on reload, and zero-network offline reopen coverage. Current feature commits `92cfa32c` and `50f33d5f` add caller-supplied release-hash trust and duplicate file-id rejection; `bae111cb` adds the static release-trust policy gate, exact release-readiness workflow placement checks, canonical release job controls, report redaction, and rollback-policy compatibility with the earlier trust upload. Fresh validation on 2026-08-10 passed `@aurora/voice-web` typecheck, focused browser-model-pack Vitest `9/9`, full package tests `110/110`, TypeScript/WASM/worker build, release policy Vitest `88/88`, full Tauri UI Vitest `419/419` with 14 skipped, Tauri UI typecheck, rollback policy package script, expected-blocking trust policy package script, `uv run make check`, and GitNexus staged detect with no mapped changes. RAC-25 is still partial because production signing material, final Android/iOS artifact hash evidence, SBOM/license tooling, and external release evidence remain open; no completion promotion is allowed.
- RAC-27 saved-role route-matrix harness is committed as `327937d0` plus reviewed reason-contract fix `136da800` in `/home/developer/projects/aurora-worktrees/rac27-desktop-all-routes-20260809`. Self-test, check-only, 8 focused Vitest tests, dependency builds, and Tauri UI typecheck pass. It covers persisted remote-console/no-sidecar, remote-console/running-sidecar, and mesh-node/python-full/sidecar profiles without `VITE_AURORA_RUNTIME_MODE`; the packaged live run was interrupted during cold native compilation before WebDriver execution, so RAC-27 remains partial and no all-route live desktop turn is claimed.
- Headless Android handoff: KVM-enabled `@aurora_api35_google` remains healthy on `emulator-5560`; packaged Aurora smoke passes in 160.69 seconds. Waydroid was untouched, no owned ADB reverses/forwards remain, MQTT/TURN containers are stopped after cleanup, and direct/STUN/TURN still require rerun with the pinned Docker socket. Local non-repo AVD data partition is 6G.
- Fresh Phase 9/10 audit at `8081d8ca`: 23 focused Tauri Android tests and 11 Rust Android tests pass, but no RAC-33 through RAC-40 status advances. The tracked Android role report is stale against current source, ordinary background voice and default-assistant execution remain deliberately withheld, and physical ARM64/OEM/locked-screen/acoustic/endurance/Play evidence remains blocked or absent. Headless emulator evidence is limited to scripted integration/lifecycle shape; final Waydroid Mobile-MCP is reserved for the fresh final APK and still cannot satisfy physical-device claims.
- Fresh Phase 11-13 audit at `8081d8ca`: iOS policy plus 10 focused iOS tests, 34 UI surface/copy tests, 4 generated-contract tests, 27 native transport tests, 26 native model-store tests, and 38 artifact-policy/bundle tests pass. No phase or RAC status advances: physical/simulator iOS, signed/notarized/store artifacts, SBOM/security/endurance, full Gateway turns, voice-data rollback, and staged rollout remain absent, external, partial, withheld, or blocked as already recorded. RAC-48 remains pass only for its current generated-contract scope. Independently approved literal-topic hardening source commit `2473ecdb` is included in the transfer integration as `39257f30`; its AST audit, Ruff, and focused Python tests pass without changing RAC counts.

- Integration owner: `/root`; owns cherry-picks, shared manifests/locks/generated outputs, final verification, capsule, and phase transitions.
- Web model-store hostile review: complete/PASS from `/root/p5_native_model_store` at `ac7af8d6`.
- Native/InMemory promoted-hash fix: complete/PASS from `/root/p5_assistant_contracts` at `45d701bc`.
- Phase 6 ABI design map: complete from `/root/p5_native_assistant_transport`.
- Phase 6 candidate/provenance map: complete from `/root/p5_model_store_scopes`.
- Phase 6 engine-contract review: PASS through integrated `8a95e75a`.
- Phase 6 VAD/KWS sys review: PASS through integrated `2ec5ef84`.
- Phase 6 VAD adapter code review: code PASS; root-owned lock correction integrated as `2fa0de71`.
- Phase 6 VAD parity review: code PASS; fresh integration report at `.artifacts/voice-runtime/vad-parity/20260807-095321/report.json`.
- Finite STT PCM ownership review: PASS; integrated as `30d73f6e` plus bounded-builder/redaction follow-up `bb9c5f1c`.
- Combined VAD/KWS/STT sys merge review: PASS; integrated merge `975eeed3` preserves independent features and reviewed native ownership/preflight behavior.
- Phase 6 candidate disposition: independently reviewed and integrated through `94ca5b5c` plus tracked-evidence hardening `28dedce6`.
- Phase 6 native diagnostic resource harness: independently reviewed and integrated through `d18ef27e`; the report is intentionally ignored and cannot satisfy physical/release evidence.
- KWS/STT adapter implementation and independent review: complete/PASS; integrated as `b3c71051` and owns only `rust/crates/aurora-voice-sherpa/**`.
- Phase 6 exit-gate verification: complete/PASS-with-withheld-capabilities from `/root/p6_exit_verifier` at `b3c71051`.
- Phase 7 browser host package: code review PASS after instance-lock/concurrency fixes; integrated as `4831df4f` plus `d84bd57b`, with the integration-owner lock importer at `f56bd424`.
- Phase 7 bounded AudioWorklet: independent code review PASS; integrated as `08e7f42a` plus lifecycle-release correction `943d83ee`.
- Phase 7 acknowledged Worker RPC/dispatcher: independent review PASS; integrated as `47c13b63`.
- Phase 7 crash-safe browser model store: all six hostile-review findings resolved and re-reviewed PASS; integrated as `a864fe7d`. Real Playwright browser proof remains active.
- Phase 7 Rust/WASM facade: epoch-safe JS timestamps, 4,800-sample frame bound, redacted false capabilities, explicit complete/repeat behavior, and explicit failure abandon behavior independently reviewed PASS; integrated as `da843a0d` plus `70899ad4`.
- Phase 7 post-stop settlement protocol: independent review PASS; integrated as `8e85c9df`. Stop retains a pending turn, repeat capture blocks until an acknowledged complete/abandon outcome, stale/foreign settlement never reaches the bridge, and lifecycle/dispose abandon pending work.
- Phase 7 real-browser model storage: Playwright evidence integrated as `1288759e` plus strict-typing/skip hardening `0b95fac1`; WebKit binary portability and partial-eviction fixes integrated as `51cab71c` plus `ffcfcd7f`. Final independent evidence review is PASS with 15/15 scenarios and zero skips.
- Phase 7 centralized surface eligibility: independently reviewed PASS and integrated as `24a430ef`. Hosted Chrome Android and Mobile Safari use the foreground browser voice path without gaining native-shell trust; native Android/iOS/Tauri remain native-only.
- Phase 7 production Worker/WASM bridge: initially failed independent review on a pending-turn shutdown leak, then fixed and re-reviewed PASS; integrated as `c473e0f9` plus `aa69d7a9`. The explicit browser package entry/build boundary is integrated as `3f82f834`, and the reproducible UI workspace dependency as `9df47319`.
- Phase 7 real-engine Worker bridge matrix: independently reviewed PASS and integrated as `195c63fe` plus strict-type correction `dd1df497`; the canonical workspace gate is `f6af787f` and passes 30/30 across Chromium, Firefox, WebKit, Android emulation, and mobile Safari emulation.
- Phase 7 runtime teardown hardening: integrated as `97be77fc`; cancellation failure still attempts Worker shutdown and preserves the sanitized primary failure. Independent review and adversarial probes are PASS.
- Phase 7 hosted-web PTT cutover: integrated as `d697b550`, exactly-once settlement hardening `f608d8d5`, and restart serialization `d881c1e4`. Independent combined review is PASS; immediate restart after Stop/lifecycle/reset waits for the old settlement and stale queued starts cannot touch the runtime.
- Phase 7 consumer-bundle repair: complete/PASS and integrated as `e5f0d46b`; frozen install, voice build/typecheck/tests, browser matrix, Next build, Tauri build, and emitted Worker/WASM graph checks pass.
- Phase 7 Android browser proof: complete/PASS and integrated through `6e56af4b`, `5251d561`, `3b74f2c9`, `8a122cc8`, and `f21c0bca`. The proof is self-reporting with no CDP execution, verifies the installed Chromium APK hash, gates emulator identity before mutation, preserves caller-owned reverse mappings, and restores package/power/command-line state on every reviewed cleanup path. WebView 124 remains an explicit engine-preflight block and was not rerun after diagnosis.
- Phase 7 RAC24 lifecycle closure: complete/PASS and integrated through `af425907`. Verification on the integration branch passes `pnpm --filter @aurora/voice-web test -- browser-lifecycle.test.ts browser-runtime.test.ts` (101 tests), `pnpm --filter @aurora/voice-web typecheck`, `pnpm --filter @aurora/ui typecheck`, and `pnpm --filter @aurora/voice-web test:browser:voice -- --grep "production browser lifecycle"` (35/35 across Chromium, Firefox, WebKit, Android-emulated Chrome, and mobile Safari emulation). The page lifecycle adapter covers hidden, frozen, pagehide, resume/pageshow recovery, and discarded-startup ineligibility without automatic restart.
- Phase 8 dependency decision: use target-scoped `cpal = "=0.18.1"` with default features disabled; integration owner retains Cargo manifest/lock ownership. Linux hardware evidence is unavailable on this host and must remain explicit.
- Phase 8 dependency slice: integrated as `d99e3633`; CPAL remains desktop-only until Android/iOS equivalence is separately proven.
- Phase 8 core playback slice: integrated as `d479b891` plus cleanup correction `ef19312a`; `VoiceRuntime` now depends on an `AudioOutput` port, does not emit `PlaybackEnded` until playback returns a generation/route-bound receipt, and preserves/propagates playback stop failures during cleanup.
- Phase 8 native playback boundary: integrated as `cc73b9ce` plus bounded callback dependency `7e0e14c0`; CPAL playback remains desktop-only and no capture, hardware playback, Tauri, Android, or iOS capability is claimed from this slice.
- Phase 8 CPAL playback foundation: integrated as `cc73b9ce`; `aurora-voice-native` exports a desktop-gated `CpalAudioOutput` with redacted errors, generation-bound receipts, basic channel/rate rendering, and deterministic conversion tests. This is not a live hardware, capture, Tauri, Android, or iOS claim.
- Phase 8 architecture review: add a core `AudioOutput` port before Tauri wiring because the current runtime discards synthesized chunks before emitting `PlaybackEnded`; add typed `CapturePrepare`/`CaptureRelease`/`CaptureStatus` handoff before native and Python capture can be mutually exclusive across processes.
- Phase 8 Python capture-owner handoff: independently reviewed PASS and staged as `54e99b3e`; exact-token renewal/release, TTL expiry, fail-closed PyAudio stop/close/thread handling, stale-event suppression, and post-lock lease-task draining are covered.
- Phase 8 public/generated handoff surface: staged as `c5563116`; the three external manage methods are included in the canonical mesh taxonomy, SDK allowlist/generated Zod artifacts, Rust contracts, and redacted status models without exposing lease tokens.
- Phase 8 native capture: independently reviewed PASS and staged as `b3a6a6a1`; callback work is limited to fixed stack blocks, `ArrayQueue`, and atomics, with opaque device tokens, exact route/lease binding, generation-safe control, bounded resampling, and overflow/discontinuity accounting.
- Phase 8 Gateway audio redaction: independently reviewed APPROVE and staged as `5040402d`; scalar-result hardening is closed by `3a1f44ba`, and the combined capture-stack review's lease-token blocker is closed and re-reviewed APPROVE at `320d38fd`. Bus payloads and HTTP responses retain the real values while log metadata excludes speech/audio content and opaque lease tokens.
- Phase 8 service speech-log redaction: independently reviewed APPROVE and staged as `818988fe`; TTS/STT service logs now emit bounded metadata while bus events and responses retain the original user content.
- Phase 8 Rust contract inventory lock: staged as `7d173800`; the generated six-schema/three-method capture handoff delta is now counted and its manage permission/feature classification is asserted.
- Phase 8 TTS synthesis port: independently reviewed APPROVE and staged as `b25bd59e`; `TtsSynthesisPort` is the sole TTS boundary, `SpeechEngine` is STT-only, local-pack and route identities remain distinct/redacted, accessors are total, and TTS cleanup failures are observable with stable sanitized codes.
- Phase 8 routed microphone policy: independently reviewed APPROVE and staged as `811f6b6a` plus public export fix `18c08364`; generated microphone-audio calls are blocked before payload normalization/allocation/network dispatch unless explicitly allowed for loopback sidecar audio or consented/configured remote routes.
- Phase 8 finite-STT port: independently reviewed APPROVE and staged as `c945ad2b`; `FiniteSttPort` now exposes distinct local-task and closed-scope route bindings, the runtime supports route-backed STT without local-pack capability, Sherpa remains local-only, and STT cleanup failures use sanitized stable codes.
- Phase 8 Gateway TTS adapter: independently reviewed APPROVE and staged as `5f827fbf` plus fail-closed response/fixture hardening `70c9e8db`; generated `TTS.Synthesize` routing rejects unsupported semantics before network access, strictly validates bounded canonical PCM16 WAV output, preserves exact route/request/generation identity, and has repeatable default-parallel cancellation coverage without hanging.
- Phase 8 Gateway STT adapter: independently reviewed APPROVE and staged as `a88bb4ca`; generated `Transcription.Transcribe` routing binds the configured scope to the actual transport endpoint class and microphone policy, rejecting blocked policy and both loopback/remote mismatch directions before payload construction or network access.
- Phase 8 synthesis/transcription architecture: independent honest local-or-route TTS and STT ports plus typed Gateway adapters are staged so neither Gateway service is represented as a local model pack. Loopback sidecar routing may be eligible, while remote microphone routing remains default-off without explicit consent/configuration. The Tauri host is now the active implementation slice.
- Phase 8 capture handoff adapter: independently reviewed APPROVE and staged through `311c0843`; loopback-only prepare/release uses a host-supplied high-entropy single-use token, recovers cancelled prepares, redacts transport/token details, and remains compatible with exact Python coordinator ownership. Fresh staging validation passes 10 Rust handoff tests and 14 focused Python coordinator tests plus Ruff.
- Phase 8 Tauri client boundary: independently reviewed APPROVE and staged through `e9df8778`; Tauri APIs are injected through the approved app-client boundary, command/listen failures are sanitized, payloads are allowlisted, and stale/duplicate status events are dropped per subscription.
- Phase 8 installed-desktop UI cutover: independently reviewed APPROVE and staged through `c806cf59`; desktop-local and desktop-thin voice ownership comes from `getAuroraSurfaceProfile`, browser mic/model/runtime paths remain disabled, exact generations survive cancellation failures, and pending-start teardown performs detached bounded shutdown cleanup without post-unmount UI updates.
- Phase 8 integration cleanup `f0796ec8` removes the temporary Tauri prop cast after the shared UI boundary landed. Fresh staging validation passes 221 focused UI lifecycle/surface tests, 35 production-copy tests, 15 Tauri IPC/boundary tests, and both UI/Tauri typechecks.
- Canonical worktree advancement is temporarily deferred because another live Codex process owns uncommitted Python handoff files there; the clean staging branch preserves all reviewed Phase 8 commits without touching that work.
- No agent may push.

## Evidence ledger

- Phase 4 checkpoint: `f7c2161c` (`Freeze the portability boundary before building the shared runtime`).
- Phase 5 hardening tail includes `02750794`, `a86a1a8e`, `d650be9e`, `fab34ec2`, `f63310d3`, `f228324b`, `f28c9b92`, `d328459c`, `d6e7804b`, `1d5e432b`, `45d701bc`, and `ac7af8d6`.
- `make check-rust-voice` passes at `ac7af8d6`: formatting, workspace all-target clippy, 59 native-runtime tests, 29 testkit tests, and 27 real browser-WASM tests, plus crate and doc tests.
- Web model-store hostile review is PASS, including exact delimiter-tuple collision isolation, identity/hash/size checks, exact selected dependency closure, validated rollback, and exact removal.
- Assistant transport focused suite passes 21 tests and independent replay review is PASS.
- Backend/SDK contract check passes with 265 methods and zero fatal/generated issues.
- Focused Python contract/Gateway suite passes: 76 tests.
- Android ARM64 and x86_64 workspace checks pass at the final Phase 5 checkpoint with NDK 27/API 26 compilers explicitly supplied to `ring` and Cargo.
- Pinned Gradle 8.13 was installed under `/home/developer/.cache/aurora-tools/gradle-8.13`; the live `emulator-5554` smoke built/installed 39 tasks and passed synthetic plus microphone capture (`acceptedDelta=12`, `samplesDelta=19200`, `dropped=5`).
- Fresh Phase 6 integration emulator smoke again built both Android Rust ABIs and 39 Gradle tasks, installed on `emulator-5554`, and passed synthetic plus live `AudioRecord` ingress (`acceptedDelta=12`, `samplesDelta=19200`, `dropped=4`).
- Fresh locked integration tests pass for engine/core/testkit/sherpa/sherpa-sys; native Silero VAD and GigaSpeech KWS pass real-model tests, clippy, and Android ARM64/x86_64 cross-checks.
- The finite STT core now carries bounded canonical PCM instead of discarding it: engine/core/testkit locked tests and all-target clippy pass, including overflow-before-EOF, stale-generation, discontinuity, cancellation, exact request identity, and redacted Debug regressions.
- The merged sys crate passes default, every single/pair/all native-feature test+clippy matrix. Real-model evidence includes 6 VAD smokes, 6 KWS smokes with `LIGHT UP`, and 5 Moonshine smokes with the exact resampled transcript; combined Android ARM64/x86_64 checks pass.
- Fresh VAD parity passes native, Chromium, Firefox, and WebKit with exact `{start:5728,length:93696}`, reset-during-feed cancellation, 31-second silence, strict isolation gates, and `physical_device_claim=false`.
- The checked-in Phase 6 disposition keeps VAD/KWS/STT/TTS production capability false, prevents every candidate manifest from entering the release index, records explicit KWS phrase/FAR/FRR/accent/distance absence, withholds the English/Linux-only Moonshine candidate, and keeps all local TTS candidates non-selectable.
- The redacted Phase 6 native diagnostic harness passes exact VAD/KWS/STT workloads with three repetitions and zero leak findings. Its ignored report records VAD p50 210 ms / p95 840 ms, KWS p50 1420 ms / p95 1429 ms, and STT p50 600 ms / p95 1302 ms; it explicitly carries `physical_device_claim=false` and is not release evidence.
- The real Sherpa adapter commit `b3c71051` passed independent review, separate `native-vad`, `native-kws`, and `native-stt` feature tests, real int8 KWS `LIGHT UP` detection, exact Moonshine transcript validation, both Android Rust target checks, full `cargo +1.88.0 test --workspace --all-targets --all-features --locked`, full workspace all-feature clippy with warnings denied, and formatting.
- The API 35 `emulator-5554` smoke was rerun after adapter/browser-package integration: both Android Rust ABIs rebuilt, 39 Gradle tasks built/installed, synthetic JNI ingress passed, and live `AudioRecord` delivered `acceptedDelta=12` / `samplesDelta=19200` into the Rust queue with `physical_device_claim=false`.
- Fresh validation at `f56bd424` passed: `rustup run 1.88.0 cargo fmt --check`, `pnpm --filter @aurora/voice-web test` (16 tests), typecheck, build, `cargo test -p aurora-voice-sherpa --all-features --locked` with real KWS/STT fixtures (28 tests), `cargo test --workspace --all-features --locked`, `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`, Android ARM64/x86_64 `cargo check`, Android emulator smoke, and `uv run pytest tests/unit/tools/test_phase6_capability_disposition.py tests/unit/tools/test_phase6_native_resources.py -q` (25 tests).
- The integrated `@aurora/voice-web` package passes frozen pnpm install, typecheck, 16 lifecycle/model-store tests, and build. Independent review verified instance-bound ownership, inactive-cancel safety, no post-cancel `frame_accepted`, strict ASCII identifiers, bounded PCM queueing, fail-closed worker errors, and unconditionally false capabilities.
- Fresh combined Phase 7 package validation at `a864fe7d` passes typecheck, build, and 65 tests across the host runtime, acknowledged RPC/dispatcher, dynamic-quantum AudioWorklet/resampler, and crash-safe browser persistence. Storage review confirmed unique promotion remaps, transactional JSON snapshots, non-NotFound propagation, IndexedDB fallback, missing-backing eviction detection, and bounded/no-copy promotion semantics; real browser execution is not yet claimed.
- Fresh integration Rust/WASM validation through `70899ad4` passes native tests, all-feature clippy, release wasm32 build, 30 browser-WASM tests under the pinned runner, and Node bindings. The generated web artifact is 143,372 bytes plus a 20,947-byte loader and contains no model weights.
- Fresh combined `@aurora/voice-web` validation at `8e85c9df` passes typecheck, build, and 72 tests after explicit Worker turn settlement was integrated.
- Fresh combined validation at `ffcfcd7f` passes typecheck, build, 75 unit tests, and all 15 real browser persistence scenarios across Chromium, Firefox, and WebKit with zero skips.
- Fresh independent validation at `24a430ef` passes the full Aurora UI suite (66 files, 626 tests), UI typecheck/build, 12 production-copy tests, and 86 targeted surface/caller regressions. The surface profile is the single authority for hosted-web browser voice eligibility and does not infer native trust from a mobile user agent.
- Fresh production bridge validation through `aa69d7a9` passes package typecheck, build, exact Rust 1.88/wasm-bindgen 0.2.126 artifact generation, and 83 tests. An adversarial shutdown probe records `start -> stop -> abandon -> free`; stale/null shutdown rejects and leaves the active generation usable.
- Fresh package-boundary validation at `3f82f834` passes package typecheck, production Rust/WASM build, 9 files/88 tests, and a built Node import probe proving the root facade excludes browser/WASM constructors while `@aurora/voice-web/browser` exposes the production factory. Frozen pnpm install and UI typecheck pass at `9df47319`.
- Fresh combined validation at `d881c1e4` passes `pnpm --filter @aurora/voice-web build`, 9 files/89 tests, client build, UI typecheck/build, 15 hosted-browser-voice tests, 25 lifecycle/unified-execution regressions, 35 product-copy checks, the full UI suite (67 files/641 tests), frozen pnpm install, and `pnpm -r build`. The real build is intentionally not Phase 7 closure evidence yet because inspection found the consumer Worker/WASM asset graph defect now being repaired.
- The consumer-bundle repair at `e5f0d46b` passes frozen install, voice typecheck/build, 94 voice tests, the canonical 30/30 browser bridge matrix, Next production build, Tauri Vite build, and emitted Worker/WASM graph and size checks.
- Fresh Phase 7 closure validation at `f21c0bca` passes frozen pnpm install; `make check-rust-voice`; voice typecheck/build and 94 package tests; the 30/30 Chromium/Firefox/WebKit/Android-emulation/Mobile-Safari-emulation browser matrix; browser persistence with 6 storage, 2 non-extractable-key, and 1 IndexedDB-to-Worker-OPFS scenario with zero skips; the focused Tauri UI suite with 28 files/271 tests; the full shared UI suite with 67 files/641 tests; Vite/Tauri production build; and emitted Worker/WASM reference checks in both the voice package and Tauri output. A first persistence invocation collided with a concurrent build of the same generated WASM directory; the uncontended sequential rerun passed.
- The final independent Android review and Phase 7 completion audit are PASS. Chromium 153.0.7996.0 on API 35/Android 15/x86_64 passed the final production Worker/WASM proof from the integration worktree in 163.63 seconds; installed `base.apk` SHA-256 matched `fafbac253a23918591ece4d506fe2155b68d68e199a9b372187071a1d8af0b80`; post-run reverse mappings were empty, Chromium was stopped/disabled, `stay_on_while_plugged_in=15`, and the command-line file was absent. The proof uses deterministic injected Int16 PCM and explicitly does not claim microphone permission, acoustic capture, or physical hardware.
- CPAL 0.18.1 dependency validation at `d99e3633` passes Linux native-crate check, 62 native-crate tests, all-target native-crate clippy with warnings denied, and direct CPAL checks for `x86_64-apple-darwin` and `x86_64-pc-windows-msvc`. The full macOS native-crate cross-check stops at the expected missing Apple C linker/SDK for `ring`; no macOS release-build claim is made from Linux.
- Core playback validation at `d479b891` passes `cargo fmt --package aurora-voice-core --package aurora-voice-testkit --check`, `cargo test -p aurora-voice-core -p aurora-voice-testkit --locked` (9 core tests and 37 testkit tests), `cargo clippy -p aurora-voice-core -p aurora-voice-testkit --all-targets --locked -- -D warnings`, and native-crate revalidation on the combined Phase 8 stack: `cargo check -p aurora-voice-native --locked`, `cargo test -p aurora-voice-native --locked` (59 native tests plus 3 candidate-pack tests), `cargo clippy -p aurora-voice-native --all-targets --locked -- -D warnings`, and `cargo tree -p aurora-voice-native -i cpal` showing `cpal v0.18.1`.
- CPAL playback-foundation validation at `cc73b9ce` passes `cargo fmt --package aurora-voice-native`, `cargo test -p aurora-voice-native --locked` (64 native tests plus 3 candidate-pack tests), and `cargo clippy -p aurora-voice-native --all-targets --locked -- -D warnings`.
- Fresh integrated validation at `d479b891` passes `pnpm install --frozen-lockfile`; `make check-rust-voice` including all-target clippy, native workspace tests, and 31 browser WASM tests; `pnpm --filter @aurora/voice-web typecheck`; `pnpm --filter @aurora/voice-web build`; `pnpm --filter @aurora/voice-web test` (10 files/94 tests); `pnpm test:web-voice` (30/30 across Chromium, Firefox, WebKit, Android-emulated Chrome, and mobile Safari emulation); `pnpm test:web-persistence` (6 storage tests, 2 envelope-key tests, and 1 IndexedDB-to-Worker OPFS smoke); `pnpm --filter @aurora/ui test` (67 files/641 tests); `pnpm --filter @aurora/web build`; and `pnpm --filter @aurora/tauri-ui build`. The emitted production assets are present in both app bundles: `apps/aurora-web/.next/static/media/voice-worker.0f0uezju60l0c.js` (43,202 bytes), `apps/aurora-web/.next/static/media/aurora_voice_wasm_bg.0p3lgiumc_z6l.wasm` (145,062 bytes), `apps/aurora-tauri/dist/assets/voice-worker-CM7AU8ZC.js` (43,202 bytes), and `apps/aurora-tauri/dist/assets/aurora_voice_wasm_bg-o0acejfp.wasm` (145,062 bytes).
- Fresh integrated Android proof at `d479b891` passes `pnpm --filter @aurora/tauri-ui exec vitest run tests/android/android-voice-worker-chromium.e2e.test.ts` on `emulator-5554` in 175.71 seconds. Post-run cleanup check shows no reverse mappings, Chromium `153.0.7996.0` stopped and disabled, `stay_on_while_plugged_in=15`, and `/data/local/tmp/chrome-command-line` absent. The proof remains deterministic injected-PCM browser/Worker/WASM evidence only and does not claim microphone permission, acoustic capture, physical mobile hardware, or durable background behavior.
- Native playback/callback validation at `7e0e14c0` passes `cargo test -p aurora-voice-native --locked` (64 native tests plus 3 candidate-pack tests), `cargo clippy -p aurora-voice-native --all-targets --locked -- -D warnings`, and `git diff --check`. Dependency-tree checks show `cpal v0.18.1` present for Linux desktop and absent from `wasm32-unknown-unknown` and `aarch64-linux-android`.
- Fresh Phase 8 handoff/contract validation at `c5563116` passes 110 focused Python contract/STT/Gateway tests, Ruff, deterministic mesh and Rust generators, SDK build plus 683 SDK tests, `cargo +1.88.0 check -p aurora-contracts`, SDK/backend conformance with 268 methods and zero fatal/generated issues, and `make check-sdk-backend-contracts`.
- Fresh integrated native-capture validation at `b3a6a6a1` passes Rust formatting, 9 core tests, 96 native tests, 3 candidate-pack tests, 39 testkit tests, and strict all-target native Clippy. No physical microphone claim is made.
- Fresh Gateway/capture-stack validation at `320d38fd` passes Ruff and 72 focused contract, STT coordinator, route-redaction, and mesh-inventory tests. Independent follow-up review confirms `lease_id` is redacted from logs while exact prepare/release bus payloads and HTTP responses remain unchanged.
- Fresh service speech-log validation at `818988fe` passes Ruff, Python compilation, 3 focused privacy tests, and both complete touched test files (62 tests). Independent review found no remaining raw request text, transcript, or audio logging in the changed service paths.
- Fresh Rust contract validation at `7d173800` passes formatting, all `aurora-contracts` tests, strict all-target clippy, and diff checks; the prior 74-vs-68 descriptor-count failure is closed.
- Fresh integrated Rust validation at `b25bd59e` passes the canonical `make check-rust-voice` gate: workspace formatting, strict workspace all-target clippy, all default-feature workspace tests (including 96 native tests, 3 candidate-pack tests, and 40 testkit tests), and 31 browser-WASM tests. A separate raw all-feature invocation is intentionally not a valid default gate because native Sherpa features require an explicit approved library path.
- Fresh native-route-policy validation at `18c08364` passes `cargo +1.88.0 fmt --manifest-path rust/Cargo.toml --all --check`, `cargo +1.88.0 test --manifest-path rust/Cargo.toml -p aurora-voice-native --locked` (100 native tests plus 3 candidate-pack tests), and `cargo +1.88.0 clippy --manifest-path rust/Cargo.toml -p aurora-voice-native --all-targets --locked -- -D warnings`.
- Fresh finite-STT integration validation at `c945ad2b` passes 9 core, 43 engine, 23 Sherpa, and 43 testkit tests plus crate doc tests. Independent review returned APPROVE with zero findings after workspace check, formatting, strict all-target Clippy, and focused locked tests.
- Fresh routed-adapter validation at `a88bb4ca` passes 114 native unit tests, 3 candidate-pack tests, focused Gateway STT and microphone-policy tests, strict all-target native Clippy, and formatting. Independent TTS and STT reviews both returned APPROVE with zero remaining findings; the STT review specifically confirmed endpoint/policy binding and pre-network rejection of blocked and mismatched routes.
- The canonical `make check-rust-voice` gate passes at `a88bb4ca`: workspace formatting, strict workspace all-target Clippy, all default-feature workspace tests (including 9 core, 43 engine, 114 native, 23 Sherpa, 9 sherpa-sys, 43 testkit, and 19 host-side WASM tests), 3 candidate-pack tests, and 31 browser-WASM tests.
- Fresh canonical `make check-rust-voice` at staging `f0796ec8` passes workspace check/format/strict all-target Clippy, 11 core tests, 43 engine tests, 124 native tests, 3 candidate-pack tests, 23 Sherpa tests, 9 sherpa-sys tests, 47 testkit tests, 20 host-side WASM tests, and 31 browser-WASM tests.
- Known unrelated canonical integration dirt to preserve: three generated Tauri schema files under `apps/aurora-tauri/src-tauri/gen/schemas/`, plus the currently live external Codex process's uncommitted Python handoff files. Do not stage, revert, or overwrite them.

## Blockers and truthful withholding

- Current sherpa PocketTTS pack: blocked from shipping/downloading/advertising because the inspected pack is English-only and non-commercial.
- Piper/espeak native/web TTS candidate: blocked by GPL distribution obligations and unresolved memory-safety findings.
- Supertonic 3 TTS candidate: technically covers required languages/targets, but remains non-selectable because the sherpa archive's MIT license file conflicts with the authoritative OpenRAIL-M model-weights license and upstream announced archival/no further support; legal/maintenance approval is absent.
- Moonshine candidate: English/Linux diagnostic candidate only; Portuguese/multilingual/auto-detect and production STT capability remain false.
- KWS candidate currently proves the `LIGHT UP` demo keyword only, not an approved Aurora production wake phrase, FAR/FRR corpus, accent/distance matrix, or physical resource gate; production KWS capability remains false.
- Physical Android/iOS acoustic, endurance, battery, thermal, locked-screen, and store-policy claims remain external evidence and corresponding capabilities must remain false until proven.
- iOS background capability remains false until physical-device and distribution-policy approval gates pass.

## RAC-01 through RAC-56 tracker

- RAC-01: partial; shared Rust core/crates and tests exist, but iOS native transport is disabled and cross-platform production runtime proof is incomplete.
- RAC-02: pass; the shared core dependency boundary is enforced.
- RAC-03: pass; bounded typed PCM, lifecycle, playback, storage, and transport ports exist for the claimed foundation scope.
- RAC-04: pass; single-owner leases and overlap rejection are covered in core/native/testkit tests.
- RAC-05: pass; generation handoff, stale-frame rejection, and cancellation semantics are covered.
- RAC-06: partial; fake UI-detached turns and a Linux hidden-window turn exist, while full platform detach/freeze/suspend proof is incomplete.
- RAC-07: pass; bounded queues, backpressure, discontinuity, and slow-consumer behavior are tested.
- RAC-08: partial; unit cleanup is strong, but real permission-loss, low-memory, device lifecycle, and all-platform audible-audio cleanup proof is incomplete.
- RAC-09: pass; sherpa-onnx remains a gated candidate rather than an unconditional final engine.
- RAC-10: pass; candidate manifests, immutable hashes, and ABI/operator/tokenizer inventories exist for the claimed scope.
- RAC-11: partial; selected VAD/ASR/KWS compatibility is bounded, while production TTS and advertised-pack release proof remain open.
- RAC-12: partial; VAD/KWS/STT parity probes pass in bounded lanes, while task-complete production parity and shippable TTS remain open.
- RAC-13: pass; task, language, target, and capability binding are tested.
- RAC-14: pass; the current English-only/non-commercial PocketTTS pack is rejected and non-selectable.
- RAC-15: withheld; no approved redistributable multilingual local PocketTTS pack exists.
- RAC-16: pass; compatibility-group and voice-state binding are enforced.
- RAC-17: pass; atomic install, resume, rollback, revocation, quota, interruption, and corruption behavior are covered.
- RAC-18: pass; wrong-hash, revoked, incompatible, and unsupported-operator states fail closed.
- RAC-19: partial; hosted web and Linux/Android client scans pass, while iOS and final signed release artifact scans remain unavailable.
- RAC-20: partial; declared resource bounds and residency tests pass, while physical thermal and battery budgets remain unmeasured.
- RAC-21: pass; pure web uses the shared Rust/WASM facade through its Worker host.
- RAC-22: partial; browser engine/Worker parity is bounded, but the full real-microphone foreground PTT matrix is incomplete.
- RAC-23: pass; capture/inference stay off the main thread in the automated web gate with bounded timer lag.
- RAC-24: pass; hidden/focus/audio lifecycle invalidation plus frozen, discarded, pagehide, pageshow, and resume behavior are covered by unit and real-browser Playwright gates without claiming automatic restart.
- RAC-25: partial; browser storage quota, interruption, eviction, recovery, reload persistence, WebCrypto manifest verification, release-hash trust, duplicate file-id rejection, local static release-trust workflow enforcement, and timeout-hardened focused guard tests pass. Production signing material, final Android/iOS artifact hashes, SBOM/license tooling, external release evidence, and a final-release reuse path remain open.
- RAC-26: pass; all five sanitized non-ready local speech states persist and restore through the hosted runtime; UI/runtime tests keep VAD/KWS/STT/TTS false, preserve authorized remote STT/TTS route selection, and keep connected-audio consent fail-closed.
- RAC-27: partial; desktop native ownership and sidecar/no-sidecar profile boundaries are tested, while the integrated all-route live turn remains open.
- RAC-28: withheld; no full UI-detached desktop background wake turn is promoted.
- RAC-29: pass; Python/native ownership handoff and coordinator exclusion are tested.
- RAC-30: partial; focused installed-desktop native ownership and browser-microphone/model suppression regressions are covered, but the full installed-desktop cutover is not proven while UI-closed background turns remain disabled.
- RAC-31: partial; sleep, device, permission, network, restart, and contention logic is bounded, while the release-device lifecycle matrix remains open.
- RAC-32: blocked; signed Windows/macOS/Linux release and installer evidence is unavailable in this lane.
- RAC-33: partial; Waydroid APK install/launch/render smoke and onboarding screenshots are proven, but no complete Gateway voice turn or physical-device proof exists.
- RAC-34: partial; foreground-service fail-closed structure is proven, while the complete OS permission/background-start/lifecycle matrix is incomplete.
- RAC-35: withheld; ordinary background session remains disabled, and notification/Stop behavior exists only for the user-started foreground service.
- RAC-36: blocked; physical ARM64 locked-screen full-turn evidence is unavailable.
- RAC-37: withheld; Android assistant-role capability remains disabled pending device, resource, and OEM gates.
- RAC-38: partial; the assistant boundary is lightweight, but accepted-wake-to-full-runtime resource proof is absent and assistant start remains disabled.
- RAC-39: partial; source/emulator interruption and restart coverage exists, while physical/OEM lifecycle evidence remains open.
- RAC-40: blocked; false-trigger, thermal, battery, acoustic, and endurance gates require reference hardware.
- RAC-41: blocked; physical iOS PTT cannot be built or run on this Linux host.
- RAC-42: pass; iOS background capability is explicitly false until every gate passes.
- RAC-43: withheld; iOS background session is exposed only as a gated boundary and is not advertised.
- RAC-44: withheld; no iOS full native background turn is claimed.
- RAC-45: partial; Swift/source and Rust lifecycle handling are bounded, while physical runtime evidence remains open.
- RAC-46: pass; iOS lifecycle policy rejects silent force-quit or reboot keep-alive behavior.
- RAC-47: pass; iOS background capability remains disabled pending physical and distribution review.
- RAC-48: pass; generated contracts, deterministic descriptors, and backend inventory checks pass.
- RAC-49: partial; bounded native HTTP/SSE cancellation, reconnect, ordering, timeout, and redaction tests pass, while a full Gateway voice turn remains open.
- RAC-50: partial; backend permission and route checks, route-scoped connected voice access, local `remoteAudioConsent: false`, route-change/revoke clearing, Android consent reset, cleartext loopback policy, rebuilt APK verification, and Waydroid smoke/onboarding evidence pass; headless WebView rendering and a complete Gateway/UI voice turn remain open.
- RAC-51: partial; Android/iOS secure-storage source exists, while full cross-platform native background credential and model-key runtime proof is absent.
- RAC-52: partial; redaction tests pass, while cloned source/embedding/state deletion and import/export/rollback privacy are not proven end to end.
- RAC-53: partial; centralized surface, production-copy, and accessibility tests pass, while model/download/voice-management states are not fully implemented.
- RAC-54: partial; model-store rollback primitives pass, while readiness withdrawal, Python/remote restoration, and user voice-data preservation are not proven end to end.
- RAC-55: pass; emulator and Waydroid evidence are explicitly distinguished from physical-device claims.
- RAC-56: partial; unmet physical/performance gates keep capabilities false, while the complete release-quality matrix remains open.

## Current Phase 8/9 handoff checkpoint (2026-08-08, supersedes earlier entries)

- Staging integration branch is clean at `890dac31` (`integrate/pockettts-p8-python-handoff-staging-20260807`); the primary worktree remains untouched.
- Desktop native live proof and the shared Rust/WASM/package gates remain green. Installed desktop and native Android ownership are routed through the centralized surface profile; native Android does not claim WebView microphone/model ownership.
- Android Phase 9 implementation is locally present: Kotlin `AudioRecord`, JNI Rust ingress/session/output, native `AudioTrack`, encrypted gateway/consent storage, foreground notification/Stop, audio-focus/interruption cleanup, task-removal/process-death fail-closed behavior, and typed Tauri/SDK wiring. The APK is built and passes the client artifact scan.
- Maintained Android smoke was hardened to classify fatal WebView renderer death. A fresh SwiftShader API-35 run installed/launched the APK and delivered the native payload, then failed after Chromium `crashpad_client_linux.cc(745)` terminated the renderer. This is host/emulator evidence only; no Android UI, acoustic, locked-screen, physical ARM64, endurance, or Play claim is promoted.
- The current AVD remains online for diagnostics (`emulator-5558`, boot complete). Direct Waydroid `192.168.240.112:5555` is now available and supplied onboarding/navigation/no-browser-mic evidence, but this is runtime evidence only and not physical-device certification.
- Generated Android/mobile schema mutations from builds were restored to `HEAD`; no generated schema drift is left in the staging worktree.

## Stop condition

Continue through revised Phases 4-13 until every advertised capability is verified, all unsupported/platform-policy-dependent capabilities are truthfully withheld, RAC-01 through RAC-56 are satisfied or explicitly blocked as allowed, the integration branch is coherently committed and verified, the primary worktree remains untouched, no agent has pushed, and an independent verifier confirms completion.

## Fresh verification checkpoint (2026-08-08 UTC)

- Phase 4 manifest validator passes on clean integration `1ba96480`: 24 artifacts, 3 denials, status `valid`; local verification remains false.
- Android universal debug AAB packaging passes with Temurin 17 and installed Android SDK. `app-universal-debug.aab` is 345,130,689 bytes; the AAB verifier scans 1,016 entries and reports zero forbidden matches with redacted secrets. APK verification remains green with zero forbidden matches.
- API-35 x86_64 emulator retry was attempted with no-window/no-audio/no-KVM TCG; `emulator-5554` remained offline and never reached boot-complete, then was stopped cleanly. No Android runtime claim is made from this retry.
- iOS policy preflight passes. Physical iOS build/device/runtime evidence remains unavailable and capability stays withheld.
- Python-free desktop client bundle passes: Vite frontend, Rust release build, AppImage, `.deb`, desktop bundle proof, and native voice artifact policy all pass with zero forbidden matches and no external voice resources.
- Maintained desktop native live E2E passes when CPAL is directed to the live PCI/PipeWire sink (`PULSE_SINK=alsa_output.pci-0000_75_00.6.analog-stereo`): completed and cancelled native turns, sidecar loopback, hidden window, and zero WebView microphone/model/worker calls. The prior default-sink failure was host audio selection (`output-stream-error` mapped to the redacted `gateway_unavailable` code), not a source regression.
- Focused Tauri native voice unit tests pass: 20/20. Integration worktree is clean at `1ba96480`; no source changes were required by this checkpoint.

## Android native capture checkpoint (2026-08-08)

- Staging commit `7ceb6e23` promotes Android foreground voice from a notification-only skeleton to a bounded native capture owner: Kotlin `AudioRecord` at 16 kHz mono PCM16, a visible foreground notification with an explicit Stop action, and a Rust-owned JNI queue with backpressure, sequence-gap counters, close/free lifecycle, and redacted status counters. No raw audio is logged or exposed.
- Validation passes: Rust format check; `cargo test --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml --lib` (113 passed); `cargo check` for `x86_64-linux-android` and `aarch64-linux-android` with NDK 27/API 26; x86_64 debug APK packaging; all six JNI symbols present in the packaged `libaurora_tauri_lib.so`; Android client bundle proof (14 passed); desktop-target Clippy with warnings denied; generated schemas restored to `HEAD` after target builds.
- An emulator was started directly on the host, but remained `offline` under no-KVM TCG and was stopped cleanly. Android WebView smoke remains unverified; this is an environment gate, not a product success claim.
- Phase 9 remains incomplete: full native PTT/STT/TTS route execution, secure model/credential/transport storage, native background-session policy, physical ARM64 microphone/acoustic evidence, and 8-hour battery/thermal/FAR/FRR gates are still withheld.

## Shared-runtime Android binding checkpoint (2026-08-08)

- Follow-up staging commit `509ea070` moves the bounded PCM queue into `rust/crates/aurora-voice-native/src/android_capture.rs`; the Tauri crate now contains only JNI handle conversion and Android result-code mapping. The shared queue has 3 direct tests and is exported as `AndroidPcmIngress`/`AndroidPcmIngressStats`/`AndroidPcmPushResult`.
- The SDK status type and fixture now carry optional redacted capture counters/backend fields without breaking older native payloads. Android x86_64 and ARM64 checks, APK packaging, JNI symbol inspection, 128 native tests, strict Rust 1.88 Clippy, 135 SDK client tests, and SDK typecheck pass.
- Lifecycle follow-up `89323d08` adds explicit Android audio-focus ownership, interruption/loss handling, critical-memory shutdown, and a documented task-removal policy. Capture is never silently restarted after a call/media interruption; the user must start it again. The service contract test passes and the Kotlin source compiles through Gradle.

## Android voice storage namespace checkpoint (2026-08-08)

- Staging commit `ddb034e8` adds the dedicated `aurora.voice` secure-storage namespace to Android Keystore validation, desktop secure-storage validation, and the SDK capability fixture. This is storage plumbing only; it does not yet claim that Android Rust transport credentials, model manifests, or weights are wired into the native voice executor.
- Validation passes: targeted Tauri secure-storage test, SDK client tests (135), SDK typecheck, diff check, and Android Gradle Kotlin compilation with the Rust build task excluded. Full APK rebuild after this namespace-only change, emulator execution, and physical ARM64 evidence remain pending.

## Rust iOS native-session checkpoint (2026-08-08 UTC)

- Staging commits `8eff5ee6`, `4c42d12e`, `77608e46`, `95df63bb`, and `5fda7c92` add the shared Rust iOS voice-session executor, C ABI, Swift borrowed-queue host, and AVAudioPlayerNode playback drain. Rust owns typed Gateway STT/TTS transport, bounded iOS PCM input/output queues, generation-safe PTT/background commands, cancellation, route policy, and redacted lifecycle status; Swift owns permission, AVAudioEngine capture, and playback.
- The ABI and Swift host are now linked by source-level policy checks, but the public `nativeTurnTransportAvailable` flag remains false. No iOS capability, device, acoustic, background, or release claim is promoted; native credential provisioning and Apple runtime evidence are still required before switching it on.
- Validation passes: iOS session source policy, iOS action policy, `pnpm --dir apps/aurora-tauri ios:policy`, Tauri `cargo +1.88.0 test --lib` (113 passed), 142 `aurora-voice-native` tests, 7 iOS bridge tests, and strict pinned Rust 1.88 Clippy. The `aarch64-apple-ios` Rust target is installed, but full Tauri cross-check remains blocked by the host's missing `xcrun`/`clang` Apple toolchain.
- Integration worktree is clean at `5fda7c92`; no push. The primary worktree remains untouched except this ignored capsule.

## Android shared audio adapters checkpoint (2026-08-08)

- Staging commit `e8bb7bdd` makes PCM chunks consumable from the shared Rust queue through JNI (`nativeDrainPcm`) and adds `AndroidPcmChunk` sequence/sample preservation. The Kotlin capture service still owns only bounded AudioRecord ingestion; it does not drain or interpret audio.
- Staging commit `d3e11b38` adds `AndroidAudioInput`, which converts queued 16-bit mono PCM into generation/route-tagged `PcmFrame`s with explicit finish/interruption and discontinuity handling. 130 native tests and strict Clippy pass.
- Staging commit `a2e93821` adds the bounded `AndroidAudioOutput` TTS handoff for Kotlin AudioTrack integration, preserving typed chunk metadata and cancellation cleanup. Focused playback tests and strict Clippy pass.
- These adapters are runtime boundaries, not an Android product cutover: no JNI session executor, credential/model wiring, AudioTrack host, emulator proof, or physical ARM64 evidence is claimed yet.
- Cross-target validation after the adapter commits passes for the Tauri Android library on `x86_64-linux-android` and `aarch64-linux-android`; the x86_64 debug APK rebuilt successfully and contains all seven PCM JNI symbols, including `nativeDrainPcm`. The generated schema files were restored to `HEAD` afterward.
- A fresh API-35 x86_64 AVD was started directly. It reached `emulator-5554 offline` under the host's no-KVM TCG setup, so APK install and Android smoke could not run; the emulator was stopped cleanly. This remains an environment gate, not product evidence.
- Staging commit `dd705790` adds the corresponding Rust-owned TTS output JNI boundary (`AuroraNativeAudioOutputBridge`) for a future Kotlin `AudioTrack` host. The subsequent x86_64 debug APK rebuild passed and exports both input and output JNI symbol sets; the output bridge remains dormant until a native session executor and AudioTrack lifecycle are connected.

## Android AudioTrack host checkpoint (2026-08-08)

- Staging commit `415115aa` adds the Kotlin `AudioTrack` consumer for the Rust-owned TTS queue. It runs on a dedicated playback thread, drains bounded PCM chunks at 16 kHz mono PCM16, and closes the native output bridge before service teardown. This is a real playback host boundary, but it is still dormant until the Rust session executor supplies typed TTS chunks.
- The full x86_64 debug APK rebuild passed after the AudioTrack change. The packaged `libaurora_tauri_lib.so` exports the complete input and output bridge JNI symbols, including PCM drain, statistics, close, and free functions. Generated schema files were restored to `HEAD` afterward and the staging worktree is clean.
- The API-35 x86_64 emulator remains unusable on this host (`emulator-5554 offline` under no-KVM TCG), so install/runtime smoke and Android WebView execution remain unverified. This is an environment gate only.
- Phase 9 remains incomplete: no native Android session executor yet, no credential/model/transport runtime wiring, no Android PTT cutover, no completed-playback acknowledgement, and no physical ARM64/background/endurance evidence.

## Android Rust session executor checkpoint (2026-08-08)

- Staging commit `fc4724f1` adds `AndroidVoiceSession` to the shared `aurora-voice-native` crate. It owns a concrete Android `VoiceRuntime` with generation-safe start/finish/cancel commands, bounded `AndroidAudioInput`/`AndroidAudioOutput`, typed Gateway STT -> assistant -> TTS adapters, redacted lifecycle status, and cancellation cleanup on a dedicated current-thread runtime.
- The Tauri Android JNI bridge now exposes native-only session creation, start, finish, cancel, PCM ingress, PCM output drain, redacted status, close, and free. A Kotlin `AuroraNativeVoiceSessionBridge` is packaged as the native controller surface, but the foreground service has not yet switched its capture/playback workers to this bridge.
- Validation passes: Rust 1.88 native suite (135 tests plus candidate-pack tests), strict Clippy, Tauri Android contract test, Android x86_64 and ARM64 cargo checks, full x86_64 debug APK rebuild, and packaged JNI symbol inspection for all nine session methods.
- Phase 9 remains incomplete: secure native configuration/model storage and service wiring are next; Android PTT cutover, completed-playback acknowledgement, emulator runtime smoke, physical ARM64 locked-screen behavior, and endurance evidence remain withheld.

## Android native session service wiring checkpoint (2026-08-08)

- Staging commit `759b19fc` wires `AuroraVoiceForegroundService` to select the Rust session bridge from native-only Keystore entries `aurora.voice.gateway` and `aurora.voice.bearer`. The service shares one Rust ingress with `AudioRecord`, drains the same Rust TTS queue through `AudioTrack`, starts one generation per foreground session, and cancels/closes that generation before bridge teardown on Stop, focus loss, or destruction.
- The service validates HTTPS endpoints (or loopback HTTP), never logs or returns decrypted values, and retains the pre-existing bounded capture-only path when no native voice profile is provisioned. This preserves a migration-safe fallback but does not advertise Android native PTT readiness by itself.
- Kotlin Gradle x86_64 debug compilation and the Tauri Android service contract test pass. Full APK rebuild after this wiring slice, emulator execution, Gateway end-to-end turn, completed-playback acknowledgement, and physical ARM64 evidence remain pending.

## Android playback acknowledgement checkpoint (2026-08-08)

- Staging commit `12b566f9` makes Android TTS completion explicit: Rust keeps the native session generation active until Kotlin `AudioTrack.write` acknowledges the final drained PCM chunk. Cancellation and close clear the acknowledgement state, and the wait loop is generation-safe and lock-lifetime clean.
- The Rust playback handoff tests now prove that queueing alone cannot complete a turn; the receipt is released only after the final chunk acknowledgement. JNI exposes acknowledgement for both the standalone output bridge and the shared voice-session bridge, and the foreground service calls it after each successful `AudioTrack` write.
- Validation passes: Rust 1.88 native suite (135 tests plus 3 candidate-pack tests), strict Clippy, Kotlin Gradle x86_64 debug compilation, Tauri static service contract test, full x86_64 debug APK build, and packaged JNI symbol inspection for both acknowledgement methods plus the complete session bridge.
- Phase 9 remains incomplete: the host API-35 x86_64 emulator is still offline under no-KVM TCG; no Gateway end-to-end Android turn, physical ARM64 locked-screen/acoustic proof, Android PTT UI cutover, local model/runtime provisioning, or endurance evidence is claimed.

## Android assistant-session handoff checkpoint (2026-08-08)

- Staging commit `21ef8259` replaces the empty declared `VoiceInteractionSession` with an explicit handoff: when Android invokes Aurora's selected assistant session, it starts the same Rust-owned foreground voice service with a dedicated assistant trigger and then hides the system session UI. The ordinary user-started foreground-service path and visible Stop action remain unchanged.
- Validation passes: Kotlin Gradle x86_64 debug compilation, the Tauri static Android service contract test, and a full x86_64 debug APK rebuild with generated schemas restored afterward.
- This is Phase 10 plumbing only, not an assistant-role or hotword release claim. Role-manager selection/revocation, OEM behavior, emulator/runtime invocation, physical ARM64, lightweight KWS, and endurance evidence remain pending; Android Phase 9 is still incomplete as well.
- Staging commit `d8467332` updates the Android plugin guide so it describes the native capture/session/playback path and its evidence-gated readiness accurately; it no longer calls the plugin a skeleton.

## Hosted web ownership propagation checkpoint (2026-08-08)

- Staging commit `b5bd5439` exposes the centralized `platform-surface` voice ownership decision in `BrowserRuntimeFeatureState`. Hosted web reports Rust/WASM browser voice ownership, while native Android shells report browser voice runtime disabled; both retain their explicit push-to-talk and wakeword owners.
- Validation passes: 54 `@aurora/ui` web-thin runtime tests, UI TypeScript no-emit check, and diff check. This closes a UI/runtime propagation gap but does not claim full pure-web browser/device parity or Android PTT cutover.

## iOS foreground capture boundary checkpoint (2026-08-08)

- Staging commit `6c23786d` promotes the tested AVAudioEngine spike into a production `aurora-voice-ios-bridge` crate plus Swift `AuroraIOSVoiceCapture`. Rust owns bounded Float32 PCM validation, backpressure, sequence discontinuities, reset, close, and redacted counters; Swift owns AVAudioSession/AVAudioEngine foreground lifecycle. Tauri exposes explicit iOS start/stop/status commands with least-privilege permission entries.
- Validation passes: iOS bridge unit tests, strict Clippy, Tauri lib suite (113 passed), Android x86_64 cross-check, iOS source-policy scripts, format/diff checks, and the UI suite (67 files / 650 tests).
- Phase 11 remains incomplete: no Swift/Xcode compile on this Linux host, no simulator or physical iOS microphone proof, no native STT/assistant/TTS transport executor, no playback path, no background capability, and no App Review/distribution approval. The new command surface is capture-boundary plumbing only.
- Staging commit `687eaaa8` updates the iOS plugin guide to describe the Rust-owned foreground capture boundary and its withheld capabilities accurately.

## Android native PTT control checkpoint (2026-08-08)

- Staging commits `7a8af605` and `9a1b1976` record this verified control/cutover slice and its command-routing regression test.
- Added explicit Rust/Tauri Android foreground voice start, finish, and cancel commands.
- Added Kotlin finish handoff that closes capture, waits on Rust session completion and queued native playback, then tears down the foreground service.
- Added a typed `NativeMobileVoicePort`; Assistant PTT now selects it from the centralized surface profile when the Android native bridge is present, with no WebView microphone path on that surface.
- Android x86_64 debug APK built successfully with explicit Temurin 17 at `apps/aurora-tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
- Focused Rust/Tauri source-contract tests, Tauri runtime tests, UI voice tests, and both package typechecks pass.
- Emulator/device end-to-end remains unproven: the available API35 x86_64 emulator stays `offline` under no-KVM TCG.

## iOS boundary review repairs (2026-08-08)

- Swift FFI calls now cast `Int` values to the C header's imported `UInt`/`uintptr_t` width.
- Fresh iOS capture start now requests microphone permission when status is undetermined and reports denied/unavailable states explicitly.
- Added a Rust link anchor so the iOS bridge crate has a force-linked symbol reference; final Xcode/iOS link still requires macOS validation.

## Android consent-boundary repair (2026-08-08)

- Staging commit `bf3e3877` carries `remoteAudioConsent` through the Rust Tauri command and Kotlin plugin into an encrypted Android Keystore-backed consent bit. Missing consent now defaults to denied; a stored bearer alone cannot authorize remote microphone routing.
- Added a native Android port typecheck regression fix and retained command-argument coverage. The Tauri Android contract test, native Android Vitest, Tauri UI typecheck, Rust formatting, and x86_64 Kotlin/Java packaging all pass.
- The generated `app:assembleX86_64Debug` package succeeded while excluding the unavailable Tauri Rust-build helper; the Rust Android artifact had already passed its cross-target build. The full Tauri APK wrapper still cannot run its local WebSocket CLI helper in this environment.
- Emulator/device runtime remains unproven: API35 x86_64 stays `offline` under no-KVM TCG. Phase 9/10 release gates, Gateway e2e, physical ARM64, and endurance evidence remain withheld.

## First-start consent propagation repair (2026-08-08)

- Staging commit `e5a90f6e` fixes a stale-state race in native desktop and Android PTT: the first start now sends the explicit consent for the current user action instead of the previous React state value.
- Focused UI voice/platform tests pass (43 tests), including voice-web/WASM rebuild and UI typecheck. Device runtime evidence remains withheld.

## Android background-session control checkpoint (2026-08-08)

- Staging commit `ae13c3bb` adds an explicit `BackgroundSession` mode to the Rust Android session executor. It uses the shared wake-turn path, records `CaptureStartReason::BackgroundSession`, and marks the lease background-eligible; ordinary PTT remains a separate mode.
- JNI and both canonical/generated Kotlin Android sources expose `nativeStartBackground`. The foreground service routes the explicit background action and the selected assistant-session action through that Rust mode while retaining the visible notification Stop action and playback-drain finish path.
- The Tauri Android static contract test and focused Rust Android session tests pass. A direct generated Gradle `app:assembleX86_64Debug -x app:rustBuildX86_64Debug` package also passes with Temurin 17 and the installed Android SDK.
- This is Phase 9/10 control-plane plumbing, not a full local background voice claim: the current Android runtime still uses gateway STT/TTS adapters, has no integrated local KWS/VAD model pipeline, and has no emulator, physical ARM64, locked-screen, battery, thermal, or assistant-role evidence.

## Android background-port exposure checkpoint (2026-08-08)

- Staging commit `5cc15a2c` exposes `startBackground` through the typed `NativeMobileVoicePort`, preserving the explicit consent payload and sending `backgroundSession: true` through the existing Tauri command. The background action is now reachable from the application boundary rather than only from Kotlin/JNI.
- The focused Android port test and Tauri UI typecheck pass. The API-35 x86_64 AVD was retried in software emulation (`-accel off`) and remained `emulator-5554 offline`; it was stopped without install or runtime claims.

## Affected-suite regression repair (2026-08-08)

- The full `@aurora/ui` suite initially found the production-shell direct-invocation guard matching the Android adapter's injected parameter name. Staging commit `1ec59b5b` renames that injected boundary to `callNative` without changing behavior.
- Verification now passes: full `@aurora/ui` suite (67 files, 650 tests), Rust workspace suite, and Android port/typecheck checks. Canvas and scroll warnings are jsdom limitations only; no test failed.

## iOS Rust PCM input adapter checkpoint (2026-08-08)

- Staging commit `1ee7d22a` upgrades the iOS bridge queue from counter-only draining to a shared-core `AuroraIosAudioInput`. It preserves bounded PCM chunks, generation and discontinuity metadata, finish/interruption controls, and deterministic linear normalization to 16 kHz.
- The bridge now has four focused tests covering backpressure/sequence accounting, closed-input behavior, resampling, and generation-safe frame draining. Strict Clippy and the full locked Rust workspace suite pass.
- This remains iOS foreground plumbing only: no Swift/Xcode link, native transport/session executor, playback bridge, simulator/device test, or iOS PTT/background capability is claimed.

## iOS Rust playback handoff checkpoint (2026-08-08)

- Staging commit `07f5fe57` adds `AuroraIosAudioOutput`, a bounded TTS queue with typed chunk metadata, cancellation cleanup, and explicit host acknowledgement before playback completion.
- Five focused iOS bridge tests, strict Clippy, and the full locked Rust workspace suite pass. The Swift AVAudioEngine playback host and native iOS turn executor are still required before any iOS PTT capability is enabled.

## iOS playback C bridge checkpoint (2026-08-08)

- Staging commit `d0e7355b` exposes the bounded Rust TTS output through the existing `CAuroraIOSVoiceBridge` header with create/free/drain/acknowledge/close symbols. Drain is capacity-safe and completion remains gated on explicit host acknowledgement.
- Staging commit `30a843f3` adds an exported-C-ABI regression test proving an undersized host buffer leaves the queued chunk intact until a sufficient buffer is supplied.
- Six focused iOS bridge tests, strict Clippy, the Tauri iOS static contract test, and the full locked Rust workspace suite pass.
- No Swift/Xcode link, simulator/device, native iOS session, or transport capability is claimed; iOS ownership flags remain withheld.

## Package and cross-surface validation checkpoint (2026-08-08)

- In the staging worktree, `pnpm install --frozen-lockfile --offline` reports all 7 workspace projects up to date after retiring the unused `@aurora/local-speech` prototype; `pnpm -r typecheck` passes across all 6 typed workspace projects, including rebuilding the Rust/WASM web package and worker.
- iOS policy preflight passes. Android preflight passes 27 checks with 1 non-required signing-input block; no signing secret was read or printed. The remaining Android device matrix is manual and still lacks emulator/physical runtime evidence.

## iOS playback status-code repair checkpoint (2026-08-08)

- Staging commit `531f25bd` separates idle, backpressure, and closed results in the iOS playback C ABI. A host can now poll an empty queue without treating normal idleness as a capacity fault; acknowledgement semantics are unchanged.
- Six bridge tests, strict Clippy, and the Tauri iOS header contract test pass. Swift/Xcode/device and native session/transport gates remain withheld.

## Fresh package regression checkpoint (2026-08-08)

- A first full UI run under concurrent native/WASM build load timed out 12 tests; the two affected assistant files passed in isolation, and an uncontended rerun passed all 67 files / 650 tests. The timeout was environmental contention, not a source failure, and no package changes were needed.
- The staging tree remains clean after the rerun; workspace typecheck and frozen offline install continue to pass.

## Android emulator retry checkpoint (2026-08-08)

- Retried the API-35 `aurora_api35` x86_64 AVD with software TCG (`-accel off`, no snapshot, wiped data). The emulator initialized its display and network services, but all 16 adb polls remained `emulator-5554 offline`; it was stopped cleanly without install or runtime claims.
- The host still reports no KVM group membership, so Android emulator execution remains unavailable evidence rather than a failed product test.

## Desktop release artifact checkpoint (2026-08-08)

- The Linux Python-free desktop client bundle built successfully, producing `Aurora_0.1.0_amd64.AppImage` and `.deb`; the desktop bundle proof passed.
- Staging commit `cba9e0d6` repairs the artifact scanner to allow package-internal AppImage symlinks while rejecting links that escape the inspected root. The real artifact policy now passes.
- Staging commit `423691b5` refreshes generated Tauri ACL/platform schemas so Android native voice commands and iOS foreground capture controls are present in packaged permissions.
- This is an unsigned Linux artifact only; signed release, non-Linux packaging, device runtime, and native mobile evidence remain pending.

## Android thin-client artifact checkpoint (2026-08-08)

- Staging commit `7afba58f` refreshes generated Android/mobile ACL schemas after the native voice command and capability inventory changed.
- The warmed full Tauri Android client build produced `app-universal-debug.apk` for x86_64 (342,481,644 bytes) and wrote build provenance. `android:verify:client:apk` passed with one inspected archive, 1,000 entries, no forbidden matches, both expected capabilities, and no Python sidecar/resources/external binaries.
- `test:android-client-bundle` passed all 14 tests. `android:preflight:ci` passed 27 checks; the only blocked check is the optional release-signing input (no keystore variables configured). Emulator/device runtime, ARM64 physical endurance, and signed store artifacts remain unproven.

## Android ARM64 artifact checkpoint (2026-08-08)

- The same full Tauri client build completed for `aarch64`; the generated Rust library was cross-compiled and packaged into the universal debug APK under `lib/arm64-v8a/libaurora_tauri_lib.so`.
- `android:verify:client:apk` passed again for the ARM64 artifact (337,730,273 bytes, no forbidden matches, three inspected files). The final artifact is unsigned debug output; signing, emulator/device execution, and endurance evidence remain separate gates.

## Android emulator environment checkpoint (2026-08-08)

- Retried `aurora_api35` with `ANDROID_SDK_ROOT` set and software TCG. The AVD initializes, but all 18 adb polls remain `emulator-5554 offline`; it was stopped cleanly.
- The emulator reports no KVM permissions for the current user and emits host display authorization warnings. This is an execution-host limitation; APK compilation and artifact inspection are independently green.

## Android native-route fail-closed checkpoint (2026-08-08)

- Staging commit `7fbbb13b` prevents Android foreground voice from reporting `startable` or opening AudioRecord when the secure native gateway profile is absent. The previous capture-only fallback could accept microphone frames without a native STT/TTS executor; it now reports `native_voice_route_missing` instead.
- The Android surface profile keeps focused push-to-talk native while withholding hands-free/wakeword ownership (`wakewordOwner: unavailable`) until a supported device/runtime gate exists.
- Static Android service contract, Kotlin compile, Android preflight (27 required checks), x86_64 APK build, artifact proof, 14 bundle tests, 135 UI platform tests, and UI typecheck pass. Emulator, secure route provisioning, and physical-device evidence remain external gates.

## Desktop native ownership test checkpoint (2026-08-08)

- Staging commit `88a25828` rewrites stale Tauri assistant tests to match the installed desktop voice boundary: coordinator voice events are not projected into the desktop composer, and push-to-talk calls `NativeDesktopVoicePort` without an `STTCoordinator.Listen` request.
- The native E2E harness is explicitly allowlisted as a reviewed Tauri command/event boundary in the service-boundary test.
- Targeted Tauri tests pass 65/65; the full Tauri suite passes 306 tests with 14 intentional skips. Physical audio and packaged macOS/Windows hosts remain external gates.
- Final local verification after this checkpoint: `pnpm --filter @aurora/tauri-ui typecheck` passed, `cargo +1.88.0 test --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml --lib native_voice --offline` passed 20/20, and the integration worktree is clean.

## iOS ownership withholding checkpoint (2026-08-08)

- Staging commit `b9f4eba2` makes the explicit iOS surface report voice capture unavailable until its native foreground bridge has a complete turn transport. The assistant no longer falls through to `getUserMedia`/`MediaRecorder` on iOS, preserving one-owner capture semantics.
- Platform and assistant regression tests pass 22/22; hosted-web and mock/browser capture paths remain unchanged. Swift/Xcode/device evidence and native iOS turn transport remain external/incomplete gates.
- The full shared UI suite now passes 67 files / 652 tests after the shell ownership expectation was updated; the full Tauri suite remains 306 passed with 14 intentional skips.

## Cross-surface route-readiness and teardown checkpoint (2026-08-08)

- The pending integration slice distinguishes Android native voice adapter presence from native route readiness. `AuroraTauriApp` probes the typed native status before enabling native PTT ownership; an Android shell with an adapter but no secure route now reports voice unavailable instead of falling through to WebView capture. Hosted Android browsers retain the explicit foreground WebView path.
- `AssistantView` now cancels active Android native capture during unmount without attempting React state updates after disposal. A focused regression test covers active native PTT teardown; surface tests cover the adapter-present/route-missing state.
- Verification: full shared UI suite passes 67 files / 654 tests; full Tauri suite passes 32 files / 306 tests with 14 intentional skips; UI and Tauri TypeScript checks pass. jsdom canvas/scroll warnings are environment limitations only.
- This does not change the withheld gates: secure Android route provisioning, emulator/physical runtime, iOS Swift/Xcode/link/device evidence, local production speech-pack capability, signed release, and full RAC/physical evidence remain incomplete.

## Native-start disposal race checkpoint (2026-08-08)

- Staging commit `aaa30603` invalidates in-flight Android native voice operations during `AssistantView` disposal. A late native `start()` result is cancelled and cannot update the disposed view or leave capture active. User cancellation also invalidates the same operation generation.
- Verification: focused assistant voice suite passes 14 tests; full shared UI suite passes 67 files / 655 tests; UI typecheck passes. jsdom canvas/scroll warnings remain environment-only.

## Android route-readiness refresh checkpoint (2026-08-08)

- Staging commit `fbc26e01` refreshes Android native voice status on a bounded interval and clears the poll on runtime/port disposal. A secure route configured or revoked after startup now updates `getAuroraSurfaceProfile` capability truth instead of leaving a stale boot-time decision.
- Verification: Tauri typecheck passes; focused Android/evidence tests pass 17/17; full Tauri suite passes 32 files / 306 tests with 14 intentional skips.

## Android route-swap and secure-config checkpoint (2026-08-08)

- Staging commit `ef08e7fc` resets native readiness before probing a replacement Android port, preventing stale availability during runtime swaps. The Android voice session also accepts the existing encrypted `aurora.gateway`/`aurora.auth` secure-storage entries as a validated fallback to the voice-specific namespace; HTTPS/loopback validation and explicit foreground consent remain required.
- Verification: Android static Rust contract test passes; Tauri typecheck passes; generated Android `:app:compileX86_64DebugKotlin -x app:rustBuildX86_64Debug` succeeds with Temurin 17 and the installed SDK; full Tauri suite passes 32 files / 306 tests with 14 intentional skips at this checkpoint.

## Android assistant-role guard checkpoint (2026-08-08)

- Staging commit `2446b086` checks `RoleManager.isRoleHeld(ROLE_ASSISTANT)` in `VoiceInteractionSessionService` before starting the foreground voice service. Revoked or unsupported assistant roles now hide the session and no-op instead of starting capture.
- Verification: Android static Rust contract test passes; generated Android Kotlin compile succeeds after syncing the canonical native plugin; Tauri typecheck passes; full Tauri suite passes 32 files / 306 tests with 14 intentional skips.
- Physical role-held/revoked behavior, OEM variation, emulator/device runtime, and signed release evidence remain external gates.

## Full Rust/package verification checkpoint (2026-08-08)

- At staging commit `2446b086`, `pnpm install --frozen-lockfile --offline` is clean; `make check-rust-voice` passes the native and WASM matrices; and `make check-sdk-backend-contracts` reports 268 backend methods with zero fatal/generated-contract issues.
- The SDK checker retains 242 bounded non-fatal fixture findings within its configured budget; these are existing fixture-coverage/policy drift findings, not generated-artifact failures.
- No source changes were produced by the verification commands; the integration worktree remains clean.
- The final shared UI run passes 67 files / 655 tests after rebuilding the SDK and voice-web Rust/WASM/Worker dependencies; jsdom canvas/scroll warnings remain environment-only.

## Android smoke readiness checkpoint (2026-08-08)

- Staging commit `4a8f042b` bounds `adb wait-for-device` in the Android emulator smoke runner. A missing/unusable emulator now fails with stable `android_device_wait_timeout` instead of hanging indefinitely; the normal WebView mount timeout remains unchanged for valid devices.
- Verification: focused Android runner/evidence suite passes 19/19; with `AURORA_ANDROID_DEVICE_WAIT_TIMEOUT_MS=1000`, the smoke command exits in about one second with the expected unavailable-device diagnostic. No emulator/device product claim is made.
- The full Tauri suite at this checkpoint passes 32 files / 306 tests with 14 intentional skips.

## Final Rust/package gate checkpoint (2026-08-08)

- Staging commit `8bbf4295` makes Android native voice lint-clean: API-level RoleManager guards, explicit RECORD_AUDIO permission gating before `AudioRecord`, a version-safe Quick Settings launch path, and removal of unsupported Android TV manifest markers. `:app:lintUniversalDebug` passes with no errors; remaining output is warnings/hints only.
- Staging commit `04cd9ed4` regenerates the mesh security inventory. Both backend-inventory/security-inventory test files pass, and the generator `--check` reports the checked JSON is current.
- Staging commit `fd4b251f` updates two stale regression inventories for the canonical speech voice-feature list and async event-subscription API. Staging commit `93cf2097` makes the gateway lifecycle fixture's awaited event subscription an `AsyncMock`.
- Package recovery is complete in the isolated worktree: `uv sync --all-extras --offline` restores the full development environment and installs `pocket-tts==2.1.0`; PocketTTS/provider targeted tests pass 107/107. The post-repair full unit run passes 3,091 / 3,130 tests with 39 skips; the stale gateway fixture is now covered by the clean full run.
- Final gates pass: `make lint`, `make check-docs`, `make check-rust-voice`, and `make check-sdk-backend-contracts` (268 backend methods, zero fatal/generated issues, 242 bounded non-fatal findings within budget). Android static Rust, Kotlin compile, Tauri typecheck, and full Tauri suite remain green.
- The Android smoke timeout now fails fast when no usable emulator is available. This host's API-35 x86_64 emulator remains offline/no-KVM; no Android runtime, physical ARM64, iOS Swift/Xcode/device, signed-release, or local production speech-pack claim is promoted.

## Superseded package retirement and final workspace checkpoint (2026-08-08)

- Staging commit `95583a89` retires the unused `packages/aurora-local-speech` TypeScript prototype. It had no production imports; the Rust `aurora-voice-engine`/`aurora-voice-testkit` model-store, lifecycle, trust, quota, revocation, and rollback paths are the sole local voice ownership implementation. Benchmarks remain comparison-only.
- `docs/NATIVE_VOICE_RUNTIME_PHASE4.md` now records the disposition and the actual pinned CPAL `0.18.1` registry dependency. The frozen offline install passes with the reduced seven-project workspace.
- Fresh package evidence: `pnpm --filter @aurora/web test` passes 15 files / 59 tests after repairing a stale expected hosted-voice ownership shape; `pnpm --filter @aurora/tauri-ui test` passes 32 files / 306 tests with 14 intentional skips; `pnpm -r typecheck`, `make lint`, `make check-docs`, `make check-rust-voice`, and `make check-sdk-backend-contracts` all pass. Existing shared UI/SDK/voice-web totals remain 655 / 683 / 94 tests respectively.
- A fresh explicit-SDK Android retry was attempted: the API-30 AVD is missing its system image, while API-35 Google x86_64 remains `emulator-5554 offline` under software TCG because `/dev/kvm` is unavailable. The emulator was stopped cleanly; this is host evidence only and does not promote an Android runtime claim.
- The post-retirement Python gate is also green: `make unit` passes 3,091 tests / 39 skips in 11m31s, with only existing deprecation/resource warnings. No source changes were produced by the test run.
- One uncontended `pnpm -r test` now passes across the remaining six test-bearing workspace projects: mock reference 3/3, SDK 683/683, voice-web 94/94, shared UI 655/655, web 59/59, and Tauri 306 passed / 14 skipped. The jsdom canvas/scroll messages are environment warnings only; the integration worktree remains clean.
- Staging commit `c627eb72` applies the repository's pinned Ruff formatting to six pre-existing speech/messaging files so the aggregate `make check` gate is actually green. Targeted tests pass 104/104 and `make check` exits 0; no behavior change was introduced.
- The local mobile-device connector reports `{"devices":[]}`. No physical Android/iOS device or usable simulator is available in this environment; remote-cloud reservation was not attempted because it would be an external/billed device action outside the current scope.

## Final capability-boundary and aggregate-gate checkpoint (2026-08-08)

- Staging commit `78505aa7` removes the unsupported `startBackground` method from the UI-facing `NativeMobileVoicePort` and Android adapter. The lower-level Android service plumbing remains dormant/internal; product UI code can only request foreground native PTT until a separately approved background capability gate exists.
- The legacy generic `mobile` surface now fails closed for wake/background ownership (`wakewordOwner: unavailable`) while retaining focused WebView PTT. A regression test covers this policy.
- Verification passes: UI platform surface (12/12), Android native/evidence suite (54/54), `@aurora/ui` typecheck, `@aurora/tauri-ui` typecheck, and aggregate `make check` (Ruff, docs, SDK/backend contracts, Rust native/WASM matrices).
- A standalone `uv run mypy --explicit-package-bases app tests scripts` remains red on pre-existing repository-wide typing debt; `make check` intentionally does not run mypy. This is recorded as a verification gap, not attributed to the Rust voice changes.
- The integration worktree was clean at `78505aa7` before the subsequent Android core and entry-point hardening; the primary worktree remains untouched except for this ignored capsule, and no push was performed.

## Android background semantics and fail-closed entry checkpoint (2026-08-08)

- Staging commit `90d86aa1` adds a shared `VoiceRuntime::run_background_turn` path and routes Android `BackgroundSession` through it. The accepted capture lease now retains `CaptureStartReason::BackgroundSession` and `background_eligible=true`; a testkit turn proves the metadata survives into the audio owner.
- Staging commit `1ba96480` rejects unsupported Android background starts at both native entry points: raw Tauri `backgroundSession` requests return `background_voice_unavailable`, and assistant/background service intents stop before AudioRecord/session startup. The product capability remains false until real KWS, physical-device lifecycle, endurance, and policy evidence exist.
- Verification at `1ba96480`: Rust core/native/testkit tests (11 core, 136 native, 3 candidate, 48 testkit passed; 1 live-audio test ignored), Android source-inventory test, x86_64 Kotlin compile, universal Android lint, and `make check` exit 0. The integration worktree is clean; no generated schema drift or push.

## Android client artifact checkpoint (2026-08-08)

- At staging commit `1ba96480`, the Android client x86_64 build completes successfully with the pinned offline toolchain. The generated universal debug APK is `apps/aurora-tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` (342,497,968 bytes).
- `pnpm --filter @aurora/tauri-ui android:verify:client:apk` passes: one archive, 1,000 entries, three checked files, zero forbidden matches, expected `aurora-android-thin` and `aurora-mobile-mesh` capabilities, and redacted provenance/config metadata.
- Build warnings are existing Rust dead-code and Gradle deprecation warnings only. The integration worktree remains clean; no source/generated schema drift or push.
- The universal debug AAB path also completes at the same checkpoint. `pnpm --filter @aurora/tauri-ui android:verify:client:aab` passes with a 345,130,689-byte archive, 1,016 entries, two checked files, zero forbidden matches, both expected capabilities, and redacted provenance/config metadata. Signing is intentionally not claimed because the local preflight has no keystore.
- A fresh API-35 Google x86_64 emulator retry was made with `-accel off`, `-no-window`, `-no-audio`, `swiftshader_indirect`, and a clean data partition. `emulator-5554` stayed `offline` for 48 seconds and never reported `sys.boot_completed=1`; it was stopped cleanly. This repeats the host-level emulator limitation and does not promote Android runtime evidence.
- The Python-free desktop client release bundle also builds locally with `--no-sign`: AppImage and `.deb` outputs are produced, and `pnpm --filter @aurora/tauri-ui verify:bundle:desktop-client` passes with two archives, 247 checked files, zero forbidden matches, and redacted metadata. The native-voice artifact policy scan passes over both installers (487 files, 60 symlinks, zero forbidden matches). Updater signing/notarization is intentionally not claimed.

## Android host retry checkpoint (2026-08-08 UTC)

- A fresh API-35 Google x86_64 AVD retry used a clean ADB server, port 5556, wiped data, software TCG, SwiftShader, no window/audio, and no boot animation. The AVD reached `adb get-state=device`, but `sys.boot_completed` remained empty for 91 polls; `init.svc.bootanim` was `stopped` and `pm list packages` returned `Can't find service: package`. The emulator was interrupted and stopped cleanly.
- This narrows the host failure from simple ADB `offline` to incomplete Android framework/package-service startup. No APK was installed and no Android product/runtime claim is promoted.

## Android install retry checkpoint (2026-08-08 UTC)

- Rebuilt the x86_64 debug APK successfully at the clean staging checkpoint; the artifact is 342,497,968 bytes and the native Rust library was cross-compiled into the package.
- A no-wipe API-35 Google x86_64 restart eventually reported emulator boot completion after approximately 208 seconds and exposed PackageManager/ActivityManager services. The maintained `android:smoke` then pushed the APK, but `pm install -r` remained stuck for over two minutes while the emulator emitted system-server contention; the smoke was stopped before any app launch. No Android runtime claim is promoted.
- The repeated TCG symptoms are stable: no `/dev/kvm`, 3–4 minute framework startup, and package installation/ADB service instability under the host emulator. The integration worktree is clean and the emulator was stopped cleanly.

## Android smoke install-timeout checkpoint (2026-08-08 UTC)

- Staging commit `75eff925` bounds `pm install -r` in the Android emulator smoke runner to five minutes by default, with `AURORA_ANDROID_INSTALL_TIMEOUT_MS` for controlled overrides. Device readiness and install failures now use distinct stable timeout codes (`android_device_wait_timeout` and `android_install_timeout`) instead of allowing an ADB command to hang indefinitely.
- Verification: `node --check apps/aurora-tauri/scripts/android-emulator-smoke.mjs`; focused smoke-runner tests pass 3/3; an unavailable-device run with `AURORA_ANDROID_DEVICE_WAIT_TIMEOUT_MS=1000` exits in about one second with `android_device_wait_timeout`. The integration worktree is clean after commit; no push.
- This improves host diagnostics only. It does not promote Android runtime, physical-device, background-wake, signing, iOS, or local production speech-pack evidence.

## iOS audio lifecycle checkpoint (2026-08-08 UTC)

- Staging commit `9b73014a` adds a Rust regression for iOS audio start–stop–start: a restarted generation drains no stale frames, resets its sequence to zero, and preserves discontinuity semantics. The existing bounded queue and C-bridge behavior remain unchanged.
- Verification: `cargo test --manifest-path rust/Cargo.toml -p aurora-voice-ios-bridge` passes 7/7; package clippy with `-D warnings` passes; `git diff --check` passes. The integration worktree is clean after commit; no push.
- This is host-side lifecycle hardening only. The iOS native Gateway/session executor, Swift/Xcode build, simulator/device PTT, and background policy evidence remain outstanding; `nativeTurnTransportAvailable` stays false.

## Full aggregate audit checkpoint (2026-08-08 UTC)

- The authoritative handoff hash remains `70b1b5ebb32c6df0e52c119b2bd73adad79c2611433bd33da7391d6e273fe196`; the replacement plan remains `50181a35cd42e12a33f8b6b1b7131a875bcafcb5a9bcc63eac06c4370ef74ea6`. The isolated integration branch is clean at `9b73014a9b220eda5bb1769ed35e3ad73502c52b`; the primary worktree remains untouched except for this ignored capsule and pre-existing user dirt.
- Fresh `make check` exits 0: Ruff/format, documentation hygiene, SDK/backend contract generation (268 methods, zero fatal/generated issues, 242 bounded non-fatal findings), Rust native/WASM workspace tests, and browser-WASM tests all pass. The iOS bridge contributes 7 host tests; one live CPAL test remains intentionally ignored without live-audio opt-in.
- Requirement audit remains incomplete by design: RAC-01/03/27/28/33/41 are not fully satisfied because the iOS native session/transport command path and physical iOS/Android/Desktop evidence are absent; RAC-35–40 and RAC-42–47 remain withheld for background/KWS/policy/device gates; RAC-55 is respected by not promoting emulator/simulator evidence.
- A partial iOS session-policy scaffold was rejected and removed before commit because it had no executor and emitted dead-code warnings. No capability flag was enabled, no generated artifact changed, and no push occurred.

## iOS native credential boundary checkpoint (2026-08-08 UTC)

- The integration branch adds `AuroraIOSVoiceCredentialStore.swift`: device-only Keychain storage for Gateway URL, optional bearer, and explicit remote-audio consent. Remote HTTPS is required; cleartext is restricted to loopback. Status and deletion responses are redacted.
- `AuroraIOSVoiceSessionHost` can now construct from the stored native configuration, without WebView-held long-lived credentials.
- Swift plugin, Rust Tauri command/permission/ACL wiring, and SDK command names/methods now expose credential set/status/delete. Provisioning never logs or returns the raw bearer.
- Public iOS voice capability remains false because Xcode/Swift, simulator/device, Gateway-turn, and policy evidence are still unavailable on this Linux host.
- Validation: iOS source policy and `pnpm --dir apps/aurora-tauri ios:policy` pass; Tauri lib tests pass 113/113; SDK typecheck passes. Integration changes are not pushed; primary remains untouched except this ignored capsule.
- Follow-up commit `f1886527` routes the existing iOS foreground start/stop/status entrypoints through `AuroraIOSVoiceSessionHost` when the withheld capability is eventually enabled, preserving generation-safe Rust cancellation; source policy and Rust formatting checks pass.
- Follow-up commit `03e84c08` adds fail-closed iOS lifecycle observers for AVAudioSession interruptions, unusable route changes, and media-services resets. Each tears down capture/playback and cancels the active Rust generation; automatic microphone restart is intentionally withheld pending device evidence.
- Follow-up commit `0ec8934d` scopes those observers to the host's own AVAudioSession, preventing unrelated app audio sessions from cancelling Aurora turns.
- Follow-up commit `c5b3cdd1` exposes the missing iOS foreground PTT finish command through Swift, Rust Tauri permissions/ACLs, and typed SDK bindings; cancel and finish remain distinct.
- Follow-up commit `6da56a54` updates `docs/NATIVE_VOICE_RUNTIME_PHASE4.md` to reflect the current Rust iOS executor/credential/playback/lifecycle evidence and explicitly preserve the Apple-runtime evidence boundary; `uv run python scripts/check_docs.py` passes.
- Follow-up commit `1ddb112f` serializes Swift PCM sequence allocation across AVAudioEngine callbacks and lifecycle resets; iOS source policy and preflight remain green.
- Follow-up commit `6e555532` makes iOS voice status read Rust-owned capture stats after native cutover rather than stale standalone Swift state.
- Follow-up commit `6f68bafc` handles iOS background entry, protected-data lock, low-power mode, and termination with explicit background-session policy; foreground sessions fail closed and no keep-alive behavior was added.
- Follow-up commit `5ff60bdb` updates the Phase 4 decision record for this app-lifecycle policy; documentation validation passes.
- Follow-up commit `8b006534` adds `native-ios-voice.ts`, wiring iOS Rust-session start/finish/cancel/status through the shared mobile PTT port while capability-gating availability; adapter tests, iOS policy, and Tauri typecheck pass.
- Follow-up commit `eaf3116e` fixes the centralized iOS surface policy so a ready native adapter can own focused PTT; wakeword/background ownership remains unavailable until its separate evidence gates pass. Platform tests 13/13 and UI/Tauri typechecks pass.
- Follow-up commit `0841bce3` exposes the existing explicit iOS background-session ABI through a separate ungranted permission and typed Tauri/SDK route; native capability remains false, and iOS source policy, SDK tests/typecheck, Rust 113-test suite, and Tauri policy preflight pass.

## Rust runtime Android packaging checkpoint (2026-08-08 UTC)

- The full Rust/WASM voice gate remains green: manifest validation passes; `make check-rust-voice` passes the native workspace and 31 browser-WASM tests.
- The Android API-35 AVD still cannot complete framework boot under software TCG on this host because `/dev/kvm` is unavailable; no emulator runtime claim is promoted.
- The Android preflight now reports 27 passed checks with only the optional signing-input check blocked. The x86_64 Rust/Tauri build succeeds and `android:verify:client:apk` passes for the 677,369,064-byte universal debug APK.
- Staging commit `7f9d5cae` makes `scripts/tauri-cli.mjs` resolve an installed asdf Temurin 17 JDK for `tauri android ...` commands when the shell's java shim is unselected. The real `android:build:apk:x86_64:debug` path now succeeds with `JAVA_HOME` unset; wrapper tests pass 8/8.
- Staging commit `5817ace8` carries the gated iOS background permission into generated ACL, Android, and mobile schema artifacts. No capability profile grants it; iOS and Android background claims remain withheld.

## Rust runtime client-bundle and desktop-contract checkpoint (2026-08-08 UTC)

- The initial check-only desktop native voice runner confirmed the Tauri application wrapper, native command contract, loopback fake Gateway boundary, managed sidecar sentinel, forbidden WebView capture/model capabilities, and redacted report policy. A later full live run supersedes its temporary “not yet driven” state (see the desktop live E2E checkpoint below).
- A fresh no-`JAVA_HOME` Python-free Android client x86_64 build completed through the real Tauri/Gradle/Rust path. `pnpm --filter @aurora/tauri-ui android:verify:client:apk` passes with one archive, 1,000 entries, zero forbidden matches, and the expected `aurora-android-thin` / `aurora-mobile-mesh` capabilities. The universal debug APK is 677,369,064 bytes with SHA-256 `0197c6b6f8b679b24e2ce2a9427d6be73e8fe7e09245cee891b6446749e91dba`.
- The package/artifact checks do not promote Android runtime, physical-device, background-wake, signing, iOS, or licensed local speech-pack capability. The integration worktree is clean and no push was performed.

## Desktop native runtime live E2E checkpoint (2026-08-08 UTC)

- A full Linux desktop native-voice E2E passed under an isolated Xvfb display with the built Tauri binary, official `tauri-driver`, `WebKitWebDriver`, and the repository-owned loopback sidecar sentinel. Aggregate report schema `aurora.desktop_native_voice_e2e.report.v1` is `passed`; desktop report digest `1e4d8c9cc6e29f5ce205abadb537256b3b67e1bde431917deb2f6821a45faafb`; Gateway report digest `864ab015ad71c5eca01a1e1a35ed58359733e5a0b25c0da914320d9cca55cb72`.
- The live run completed one native turn and one cancelled turn, observed distinct generations and monotonic redacted status sequences, exercised `aurora_native_voice_status/start/finish/cancel`, hid the window during cancellation, and recorded no WebView microphone, model-load, or browser-worker calls. Loopback Gateway required routes were hit: CapturePrepare 2, CaptureRelease 2, Transcribe 2, ExternalUserInput 2, Interrupt 1, TTS 1, events stream 7.
- This proves the desktop sidecar-loopback native path and no-WebView ownership contract on Linux. Remote-no-sidecar, Windows/macOS release, physical mobile, background-policy, signing, and licensed production-pack evidence remain separate gates and are not promoted by this run.

## Rust/WASM hosted-web verification checkpoint (2026-08-08 UTC)

- `pnpm --filter @aurora/voice-web test` passes 10 files / 94 tests; its TypeScript, Rust/WASM, and worker build completes successfully, including the optimized WASM artifact.
- `pnpm --filter @aurora/web test` passes 15 files / 59 tests. The browser host remains foreground-only and no background capability is promoted.
- The integration worktree remains clean after these checks; no source or generated schema drift was produced.

## Rust core and manifest revalidation checkpoint (2026-08-08 UTC)

- `python tools/voice-runtime/validate_phase4_manifest.py` remains valid (`artifact_count=24`, `denial_count=3`, `errors=[]`, `verified_local=false`).
- `make check-rust-voice` exits 0, including the native workspace and 31 browser-WASM tests. The green result covers ownership/generation, bounded PCM, cancellation, model-store rollback/revocation, native transport contracts, and WASM facade behavior; it does not convert denied model/device/policy rows into production capability.
- The integration worktree remains clean; no push was performed.

## Native Gateway reconnect hardening checkpoint (2026-08-08 UTC)

- Staging commit `1c867a9d` closes a real RAC-49 gap: native assistant SSE turns now reconnect at most twice after a clean close, request failure, or stream timeout, resuming with the last accepted event ID while the existing sequence/generation deduplication rejects replayed chunks. Cancellation and bounded response limits remain unchanged.
- The commit also normalizes five native audio divisibility checks to the Rust standard API required by the installed Clippy, with no behavior change.
- Verification: native crate tests pass 143/143 plus candidate-pack tests 3/3; native crate Clippy with `-D warnings` passes; `make check-rust-voice` exits 0 with 31 WASM tests. A live remote-Gateway reconnect and physical-device transport remain untested external evidence.

- Downstream verification after the transport commit: frontend build passes, `cargo check --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml --features tauri/custom-protocol` passes, and focused Tauri native-voice/E2E contract tests pass 17/17. Tauri schema generation was restored to the committed canonical artifact after the build; the integration tree is clean.

## Native Gateway bounded-open retry checkpoint (2026-08-08 UTC)

- Staging commit `071de967` closes the next local RAC-49 transport gap: initial and resumed assistant SSE subscriptions retry transient request/timeout failures within the existing two-reconnect budget. Protocol/HTTP semantic failures still fail closed; cancellation, event-id resume, sequence validation, and response bounds are unchanged.
- Verification: native crate tests pass 144/144, candidate-pack tests 3/3, native Clippy with `-D warnings` passes, and `make check-rust-voice` exits 0 with 31 browser-WASM tests. The integration worktree is clean at `071de967`; no push.
- This remains host-side evidence. Live remote Gateway reconnect, Android/iOS device execution, background wake/KWS, signing, and licensed production local-speech-pack evidence remain unproven and are not promoted.

## Android visible-notification capability checkpoint (2026-08-08 UTC)

- Staging commit `25949eef` tightens the Android foreground-service gate: `startable` now requires `NotificationManagerCompat.areNotificationsEnabled()` in addition to runtime permission, microphone permission, service manifest readiness, and secure native Gateway configuration. The status exposes `notificationReady` and reports a stable unavailable reason when the required indicator cannot be delivered.
- Verification: the full Tauri Rust suite passes 113/113; Android x86_64 Kotlin compilation succeeds with the installed Temurin 17 and SDK; `make check-rust-voice` passes with 144 native tests, 3 candidate-pack tests, and 31 browser-WASM tests. The integration tree is clean at `25949eef`; no push.
- This closes a local foreground-service safety gap but does not promote Android runtime, background wake/KWS, emulator, physical ARM64, battery/thermal, signing, or Play-policy evidence.

## Android AVD and mobile-MCP validation checkpoint (2026-08-08 UTC)

- The requested device split was attempted. The maintained scripted smoke ran against a second API-35 x86_64 headless AVD (`emulator-5558`, `aurora_api35`) after it reached `sys.boot_completed=1` and `device_provisioned=1`; the original Google API-35 AVD remained `emulator-5556`.
- The alternate smoke installed the 679,189,872-byte integration APK, launched `dev.aurora.desktop`, emitted the redacted Android native payload in 21 chunks (`bytes=18775`, begin/end markers observed), and exposed `webview_devtools_remote_3334`. The test then timed out at 480,000 ms before a stable rendered Aurora state. Device logcat records repeated emulator ANRs and a Chromium renderer fatal (`Render process ... crash wasn't handled by all associated webviews`), followed by the Aurora process being killed. This is a host/emulator resource failure, not a passing UI result.
- `mcp__mobile_mcp__mobile_list_available_devices` found only local Android emulators (`aurora_api35_google` and later `aurora_api35`); no Waydroid binary, service, process, container, or ADB endpoint exists on this host. No remote cloud device was allocated because the request was specifically for local Waydroid and remote allocation is a separate user-authorized resource.
- Mobile-MCP screenshot and hierarchy checks were executed on the local emulator. Screenshots were saved to `/tmp/aurora-mobilemcp-emulator-5556.png` and `/tmp/aurora-mobilemcp-emulator-5558.png`; both show system/launcher `isn't responding` dialogs, and hierarchy extraction returned only the root frame. No Aurora navigation/screenshot acceptance claim is made.
- RAC-33/34/39 gain emulator packaging/payload/launch evidence only; RAC-55 remains enforced. Waydroid full UI navigation, screenshots, physical mobile capture, background wake/KWS, and release-device evidence remain outstanding. The integration worktree was rechecked clean after the build and smoke attempts; the primary worktree retains unrelated pre-existing user edits and was not reset.
- Follow-up single-AVD rerun after stopping `emulator-5556`: `emulator-5558` cold-booted alone, the same APK installed and launched, and the native payload begin/end markers were observed again. The app's Chromium renderer then crashed (`crashpad_client_linux.cc ... Render process ... crash wasn't handled by all associated webviews`); mobile-MCP captured `/tmp/aurora-mobilemcp-single-avd.png`, showing the emulator's `Quickstep isn't responding` dialog. This isolates the remaining scripted/UI failure to the no-KVM software-TCG emulator/WebView environment rather than concurrent emulator contention.

## Android smoke diagnostics hardening checkpoint (2026-08-08 UTC)

- Staging commit `890dac31` hardens the maintained Android smoke runner to fail fast when logcat reports a fatal Chromium/WebView renderer crash, instead of waiting for the full mount timeout. The classifier covers the observed `crashpad_client_linux` / `Render process` fatal signature and the static evidence test locks the diagnostic path.
- Targeted verification: `ci-native-evidence.test.ts` passes 16/16. A fresh single-AVD smoke run against `emulator-5558` failed in 152.58 seconds with the explicit renderer-crash diagnostic after the APK installed, launched, emitted all 21 native payload chunks (`bytes=18775`), and exposed WebView DevTools. Logcat then recorded the renderer fatal and Aurora process death. This confirms package/build/payload delivery while keeping the UI result correctly failed.
- The Rust Android foreground-service bridge is already complete at this staging head: Rust commands, Kotlin plugin start/finish/stop handlers, typed TS adapter, capability permission, and contract tests are present. No bridge patch is warranted; native mobile availability remains policy-gated and fail-closed.
- Waydroid remains unavailable on this host (no binary, package, service, process, container, or ADB endpoint). The integration worktree is clean at `890dac31`; no push was performed.

## Current-head revalidation checkpoint (2026-08-08 UTC)

- `make check` passes: Ruff, formatting, documentation hygiene, and SDK/backend contract regeneration/checks all exit 0.
- `make check-rust-voice` passes at `890dac31`: native workspace tests (including 144 `aurora-voice-native` tests and 3 candidate-pack tests), strict checks, and 31 browser-WASM tests all pass; one live CPAL hardware test remains intentionally ignored unless explicitly enabled.
- Focused Tauri Android/native evidence tests pass 54/54, shared UI surface-policy tests pass 13/13, and Android native session tests pass 4/4.
- `android:verify:client:apk` passes with zero forbidden artifact matches. `android:preflight:strict` reports 27 passed checks and one blocked optional signing-input check; no source/generated drift was produced.
- `cargo test --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml --lib --locked` passes all 113 Tauri Rust tests, including Android native plugin/service ownership, secure storage, iOS boundary, native voice lifecycle, and redaction checks.
- The second AVD remains boot-complete as `emulator-5558`; the maintained smoke runner correctly fails fast on the host's fatal Chromium renderer crash. No Waydroid endpoint exists. The integration worktree remains clean at `890dac31`.
- Additional environment attempt: a clean `-gpu off -no-snapshot` API-35 AVD on `emulator-5560` never reached `sys.boot_completed=1` under the same no-KVM TCG host and was stopped. The known SwiftShader AVD on `emulator-5558` was restored and booted; a fresh smoke run installed/launched the APK, then failed after 365.05 seconds with the same explicit `crashpad_client_linux.cc(745)` renderer fatal. Mobile-MCP latest screenshot `/tmp/aurora-mobilemcp-latest.png` shows `Quickstep isn't responding`; hierarchy has only the root content frame. No Aurora UI/navigation claim is made.

## Waydroid direct-device validation and Android fail-closed PTT checkpoint (2026-08-08 UTC)

- The user-provided Waydroid endpoint is reachable directly as `192.168.240.112:5555` (Android 13, package `dev.aurora.desktop`). Mobile-MCP install/launch completed with the rebuilt x86_64 universal debug APK (`344,316,592` bytes, SHA-256 `76770de647ff26501e1f83c70b975f24f7f36c75fbf7ff209132703debead92c`); `android:verify:client:apk` passed.
- The maintained scripted Android smoke passed on Waydroid: one file / one test, 24.27 seconds. The smoke validates APK delivery, redacted native payload, WebView target, and rendered onboarding/assistant root. Mobile-MCP crash inventory remained empty (`[]`).
- Full UI navigation was exercised through the packaged WebView: node onboarding selection, invite paste/save using a valid `amv1` invite, Mesh status, and Assistant navigation. Final Assistant screenshot was saved at `/tmp/waydroid-android-native-route-unavailable.png`.
- Runtime inspection showed the physical Android surface correctly selected `focusedPushToTalkOwner: unavailable` because the native adapter was present but no secure Gateway voice route was provisioned. Before this fix, Android fell through to browser `getUserMedia`; `AssistantView` now fails closed for Android and iOS unavailable native routes. A CDP-wrapped `getUserMedia`/`MediaRecorder` trace after tapping “Push to talk” recorded no browser capture calls, and the product page remained stable.
- Regression coverage: `packages/aurora-ui/tests/assistant-hidden-mic-release.test.tsx` now covers Android route-unavailable no-fallback behavior; focused UI validation passes 3 files / 51 tests. The rebuilt APK and Waydroid smoke pass after the change.
- The native foreground voice turn remains intentionally unclaimed because this Waydroid session has no provisioned secure Gateway/bearer route (`nativeSessionReady=false`, `startable=false`, reason `native_voice_route_missing`). Physical ARM64/OEM, locked-screen/background, battery/thermal, iOS, signing, and production local speech-pack gates remain withheld. The dynamic runtime role rule is preserved: role is selected from onboarding/profile, never from environment or compiled APK mode.

## Post-Waydroid contract and route-provisioning audit (2026-08-08 UTC)

- A fresh `make check` run reached the Rust/WASM voice matrix successfully: 11 core, 43 engine, 7 iOS bridge, 144 native, 3 candidate-pack, 48 testkit, 20 WASM facade, and 31 browser-WASM tests passed; SDK/backend contract generation reported 268 methods, zero fatal/generated issues, and the bounded 242 non-fatal fixture findings. The worktree remained clean.
- Attempting to provision a loopback voice endpoint through the existing typed `aurora_secure_storage_set` command on the installed Android client was rejected by Tauri ACL (`not allowed; permissions ... allow-aurora-secure-storage-set, aurora-secure-storage`). This is evidence that the packaged Android client remains the deliberately narrow thin capability; it is not evidence of a native voice transport failure. The runtime role invariant remains unchanged and no environment/build role was introduced.
- Consequently, the Waydroid native capture/notification turn cannot be promoted from “route missing” without an approved runtime provisioning boundary for the node role or an authorized Gateway invite flow that supplies native credentials. Do not bypass this ACL from the WebView or weaken the thin capability as a test shortcut; resolve it through the runtime-role/capability design before claiming RAC-33/34 native capture on the client APK.

## Independent completion audit (2026-08-08 UTC)

- Independent verifier verdict: **PARTIAL**, not complete. Current clean integration HEAD is `b9b206edef89e39efc936b6f52d46d0aa196101c`.
- The verifier confirmed the Android unavailable-native-route guard, artifact cleanliness, runtime-configured endpoints, and current clean tree. It also confirmed the authoritative stop condition remains open for KVM-backed Android aggregate evidence, macOS MobileSafari/WKWebView runtime evidence, forced-TURN mobile interop, and physical Android/iOS direct/STUN/TURN certification.
- No tracked report currently proves the Waydroid smoke/no-`getUserMedia`/Mobile-MCP crash inventory; those local artifacts remain under `/tmp` and are summarized above. Do not promote them as release evidence or mark the Goal complete from them alone.
- Historical checkpoint: work was still active here. Its next deliverable was a RAC/acceptance traceability record; the strict inventory override at the top now supersedes this checkpoint and keeps the replacement work paused/incomplete.

## Dynamic runtime-role route-sync checkpoint (2026-08-08 UTC)

- The Android native voice route is now derived on-device from the active persisted runtime profile plus the native thin peer-credential store. `AuroraNativePlugin` mirrors the selected `gatewayUrl`/peer credential into the native voice config on resume and after profile/credential mutations; raw gateway and bearer values are never returned to the WebView. Invalid, missing, or unauthenticated remote routes clear the native route and report only redacted status reasons.
- This preserves the product invariant: role is selected dynamically by onboarding/runtime profile and is never selected by environment variables or compiled APK mode. The same APK can represent a remote-console manager or a mesh-node runtime; route sync consumes that profile and does not inspect or assign `nodeMode`, `runtimeTier`, or `VITE_AURORA_RUNTIME_MODE`.
- The thin Android capability remains narrow. No generic secure-storage permission was added; the route uses the existing native-owned profile/peer stores and voice-owned encrypted keys. Static route-policy tests pass 8/8.
- Rebuilt universal x86_64 debug APK: 344,316,584 bytes, SHA-256 `24c00282399f88cd543f926dea14bc4253292b0a15298f3ccc2661d8224ef9f6`. `android:verify:client:apk` passes and maintained Waydroid scripted smoke passes 1/1 after install/launch.
- Waydroid `192.168.240.112:5555` Mobile-MCP validation: install/launch succeeds; crash inventory is empty (`[]`); hierarchy is stable at the native root/navigation layer; screenshot saved as `/tmp/waydroid-route-sync-fixed.png` (1080x2400) shows the Aurora Assistant surface without a crash. WebView content is not exposed through the device hierarchy, so screenshot evidence is retained as local UI evidence only.
- With a loopback profile route (`http://127.0.0.1:8000`) and `adb reverse`, live native foreground capture on Waydroid is startable and records real AudioRecord/JNI queue data. One run reported 16 accepted chunks / 25,600 samples / one queued chunk while active, then returned to zero chunks, zero samples, and `captureActive=false` after finish. Notification, microphone, manifest, and foreground-service gates were all ready. This upgrades RAC-33 to native Android PTT capture green on Waydroid, but not to a complete Aurora Gateway turn: a full end-to-end Gateway request/response was not observed and remains unclaimed.
- Historical checkpoint: the remaining hard-stop rows included physical ARM64/OEM, KVM-backed emulator aggregate UI, iOS/macOS runtime, forced-TURN interop, background/KWS policy, signing/notarization, and licensed production local speech-pack evidence. The strict audit now governs the paused/incomplete state.

## Current device-split rerun checkpoint (2026-08-08 UTC)

- Current clean integration HEAD is `719285d4` on `integrate/pockettts-p8-python-handoff-staging-20260807`; the primary worktree remains untouched except the intended AGENTS/memory updates.
- The requested headless scripted lane ran the current 344,316,584-byte APK on `emulator-5558` (API 35, Android 15, x86_64). Install and launch completed, then the bounded E2E failed after 136.17 seconds on the known fatal Chromium renderer signature (`crashpad_client_linux.cc(745)` / unhandled WebView renderer crash). The runner correctly classified this as a renderer-crash failure; no rendered-Aurora pass is promoted.
- Waydroid `192.168.240.112:5555` remains healthy with Mobile-MCP crash inventory `[]`. A fresh screenshot was saved to `/tmp/waydroid-role-selected-fixed.png` and visually inspected: the packaged UI shows the user-facing role choice “Connect to Aurora” versus “Make this device available,” then the selected-role connection screen. The screenshot source has a 57-byte Mobile-MCP stderr prefix; the fixed PNG is valid 1080x2400 RGBA. This is direct UI/navigation evidence of profile-driven role selection, not an environment/build role claim.
- Fresh `make check` at `43bdecbe` passes Ruff, documentation hygiene, SDK/backend contract regeneration (268 methods, zero fatal/generated issues), the Rust native/WASM matrix (11 core, 43 engine, 7 iOS bridge, 144 native, 3 candidate-pack, 48 testkit, 20 WASM facade, and 31 browser-WASM tests), and all doc tests. The known bounded non-fatal SDK fixture findings remain within budget; no source drift was produced.

## Tracked Android role-evidence record (2026-08-08 UTC)

- Added `reports/native-voice/android-runtime-role-evidence.json` at integration commit `683dcb34` (SHA-256 `9ff32b24b50a51266e77ed3268d1bec16dad95c39b61fbec6ef20f7638e89cfe`). Its `codeEvidenceBaselineHead` remains `719285d4`, while `reportCommit` records the original evidence commit `93225dc5`; the redacted report records the current APK hash, Waydroid/Mobile-MCP results, role-selection screenshots, profile-derived native route status, native capture metrics, headless renderer-crash evidence, and explicit withheld claims.
- The report makes the product invariant auditable: role is never selected by environment or APK build, the same APK supports remote-console and mesh-node profiles, and native route synchronization does not assign a role. It records `fullGatewayTurn=false`, `physicalDevice=false`, `backgroundCapture=false`, `iosNative=false`, `releaseSigning=false`, and `physicalTurnOrRelay=false`.
- This historical evidence record closed one tracking gap but did not close the external hard-stop rows or complete the work. The strict audit now governs the paused/incomplete state.

## RAC ledger and fresh suite checkpoint (2026-08-08 UTC)

- Added `reports/native-voice/native-voice-rac-matrix.json` at integration commit `05eb3eb2` (SHA-256 `f6ca0115c15bd88df89f9cd7d919756c79be313b91e3be2deff382b2d038ebce`). Its `codeEvidenceBaselineHead` remains `719285d4`, while `reportCommit` records `932e4ae2`; it contains all RAC-01 through RAC-56 IDs with explicit `pass`, `partial`, `withheld`, or `blocked` states and names the evidence or gap for every row.
- Fresh affected suites at the same code checkpoint: `packages/aurora-ui` passed 67 files / 658 tests; `apps/aurora-tauri` passed 34 files / 312 tests with 14 skipped; `cargo test --manifest-path rust/Cargo.toml --workspace --locked` passed all workspace tests (144 native, 48 testkit, 20 WASM facade, 7 iOS bridge, plus contracts/engine/sherpa suites).
- Historical/superseded ledger result: 36 pass, 11 partial, 5 withheld, and 4 blocked. The first strict audit corrected this to 24 pass, 22 partial, 6 withheld, and 4 blocked; the independent Phase 7 adjudication further corrected it to 21 pass, 25 partial, 6 withheld, and 4 blocked; RAC24 closure at `af425907` temporarily advanced the count to 22 pass and 24 partial; the Phase 8 audit at `18811e46` then correctly returned RAC30 to partial, yielding 21 pass and 25 partial; RAC26 closure at `16f58c8e` advances the current authoritative state to **22 pass, 24 partial, 6 withheld, and 4 blocked**; dynamic-role repair through `37a506dc` changes RAC-27 evidence only and does not change counts. The replacement work remains active/incomplete until the resume gate is satisfied.

## Multi-artifact client scan checkpoint (2026-08-08 UTC)

- Hosted web production build passes via `pnpm --filter @aurora/web build`; the built client remains role-agnostic and does not inject a runtime role.
- Linux desktop client bundles were built with the installed `cargo tauri` fallback after clearing orphaned D-Bus sessions that had exhausted the inotify instance quota. AppImage SHA-256 `2dfc7c099e535720149ad580a25c27f7e81db9cf6e2a4f616706e8a15d8f514d` (92,137,976 bytes) and DEB SHA-256 `19cf166db178e4817ccc040630dfd3344a94660ccc8f33057a4dd7fcee7ff8d5` (19,116,472 bytes) both pass `verify:bundle:desktop-client` and native-voice artifact policy with zero forbidden matches.
- Android universal debug AAB build now passes after the same environment cleanup. `app-universal-debug.aab` SHA-256 `c58f23f046f5722830e951bf5a322d66198a9cf0fd4a3257f334120ca05b1739` (347,061,847 bytes); `android:verify:client:aab` reports zero forbidden matches.
- IPA build/scan remains unavailable on this Linux host, so RAC-19 stays partial. The tracked role-evidence report and RAC matrix now record hosted web, Linux desktop, Android APK, and Android AAB evidence plus the IPA gap. Runtime-role invariant remains unchanged: roles come from onboarding/profile state, never environment variables or compiled artifact mode.
- Evidence-report commit `6820dc83` records the multi-artifact scan update. Report hashes: `android-runtime-role-evidence.json` `2a4ed8424315139128a6a5afbf7491def0fb541f5e2b7cd11ecb3270455b7eb2`; `native-voice-rac-matrix.json` `034213c2c1018e348fa4f4b38259fe7006f9238ef876ee53a7762fd710d0c82b`.

## Profile-selected package role checkpoint (2026-08-08 UTC)

- Integration commit `c833a41e` removes `VITE_AURORA_RUNTIME_MODE` from native production entry/build code, desktop live/native-voice build wrappers, and Python-full capability authorization. A native shell now always loads persisted runtime profile state before choosing local-node or remote-console behavior; the package remains role-neutral.
- The same commit keeps the dynamic role contract explicit: `remote-console` and `mesh-node` remain profile-owned, while physical Android/iOS/desktop detection uses native/browser surface signals. Test-only E2E hooks are gated by capability flags and no longer by a role environment variable.
- Verification: Tauri typecheck passed; full Tauri suite passed 34 files / 312 tests with 14 skipped; targeted role/profile tests passed 127/127; Android client bundle proof passed 14/14; desktop bundle proof passed; desktop/Android/iOS client frontend builds passed; built frontend artifacts contain no `VITE_AURORA_RUNTIME_MODE`.
- Remaining goal gaps are unchanged: complete Waydroid Gateway request/response turn, headless WebView renderer stability, physical ARM64/iOS/macOS evidence, background lifecycle/endurance, forced TURN, signing/store policy, and licensed production speech-pack evidence.

## Role-neutral APK refresh and device split (2026-08-08 UTC)

- Rebuilt the x86_64 Android client APK from `c833a41e`; artifact SHA-256 `28a1aed66f1d26e1f9fa32ee5e8b91bfc27f4c6232f8f0a0497d17a288005d97`, size 344,316,584 bytes. `android:verify:client:apk` passed with zero forbidden matches.
- Waydroid `192.168.240.112:5555` maintained smoke passed 1/1 in 80.97s after installing this exact APK.
- Headless `emulator-5558` used the same APK; install/launch and native payload delivery completed, but scripted WebView E2E failed in 142.62s on the known fatal Chromium renderer signature (`crashpad_client_linux.cc(745)`), so no rendered-Aurora pass is promoted.
- Build initially hit the host's inotify limit because 184 orphaned developer D-Bus session daemons were present; only PPID-1 orphaned sessions were terminated, then the build completed. No repository files were removed or reset.
- Tracked report refresh commit `58972e0d` updates `android-runtime-role-evidence.json` to the new APK hash and records the 80.97s Waydroid pass plus 142.62s headless renderer-crash failure; JSON validation passes.

## Waydroid Mobile-MCP fallback UI checkpoint (2026-08-08 UTC)

- Mobile-MCP was attempted twice against the local device inventory; both calls failed because the connector transport closed before returning devices. The tracked report records this as unavailable rather than claiming MCP coverage.
- Direct ADB validation against the user-provided Waydroid endpoint `192.168.240.112:5555` succeeded with the same role-neutral APK: launch displayed the Aurora onboarding UI, selecting “Connect to Aurora” persisted the choice, and Continue reached the invite onboarding screen. UIAutomator reported package `dev.aurora.desktop` with a live WebView; no app crash signature appeared after navigation.
- Fresh screenshot hashes: `/tmp/waydroid-connect-selected.png` SHA-256 `08144fca1380cfa2bd337d3f9825363d029fbc361946abc6fd7c76c5cff90fc8`, and `/tmp/waydroid-connect-flow-final.png` SHA-256 `54e35b44d2a45b04ca1970b6d47a75528ef8216b934f0847955f20cc2145755b` (both 1080x2400). The latter visibly shows the invite onboarding fields and actions.
- Tracked report commit `66d71c88` adds the connector failure, direct-ADB fallback method, screenshot hashes, UI navigation result, and explicit untested Mobile-MCP/Gateway-turn gaps. The dynamic role invariant remains unchanged; the strict audit now governs the paused/incomplete state.
