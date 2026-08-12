# PocketTTS native/WASM voice goal capsule

Updated: 2026-08-12T04:00:53Z

## Authority and workflow

- Active normal Codex Goal: `019ff2c7-e905-7100-810e-6afdda24c833`.
- Do not invoke or revive OMX Ultragoal. Its archived state is provenance only.
- Authoritative plan: `.omx/plans/pockettts-cross-surface-local-voice-plan.md`.
- Authoritative RAC tracker: `reports/native-voice/native-voice-rac-matrix.json`.
- Continuation handoff: `.omx/state/pockettts-native-voice-fresh-session-handoff.md`.
- Branch: `feat/ui-multi-platform-integration`.
- Current implementation/evidence head before this state-only sync: `280320191ae7efaf85f0a12d2e2c92ba452cd086`.
- Revised plan SHA-256: `50181a35cd42e12a33f8b6b1b7131a875bcafcb5a9bcc63eac06c4370ef74ea6`.
- No push was performed.

## Overall disposition

The requested repo-local implementation and bounded verification work through
Phases 4-13 is complete. The product release is **not** complete or ready.
Phases 6-13 retain partial, withheld, or blocked dispositions wherever assets,
physical devices, platform runtimes, legal review, signing/store evidence,
runtime rollback, or production speech packs are absent.

Production VAD, KWS, STT, and TTS remain false. No revised RAC status was
promoted during the final Phase 9-13 evidence pass. Criterion totals remain:
**22 pass / 25 partial / 5 withheld / 4 blocked**.

## Phase inventory

| Phase | Current disposition | Bounded evidence and remaining gate |
| --- | --- | --- |
| 0-3 | Preserved implementation; partial current verification | Existing provider, contract, configuration, and regression surfaces remain intact. Environment- and asset-dependent coverage is not promoted. |
| 4 | Closed for architecture/portability scope only | Pinned sources, native/cross-target builds, WASM workers, and bounded parity pass. Live hardware, Apple runtime/signing, release packaging, and TTS activation remain excluded. Receipt: `reports/native-voice/phase4-reverify-20260811/`. |
| 5 | Closed for shared-foundation scope only | Rust/WASM foundation, generation stability, ownership/store behavior, and browser matrix pass. Hardware, releases, and production packs remain later gates. Receipt: `reports/native-voice/phase5-reverify-20260811/`. |
| 6 | Partial-withheld; disposition verified | Validation candidates pass bounded trust/resource checks, but no release-eligible interoperable pack exists and TTS is unavailable. Receipt: `reports/native-voice/phase6-disposition-20260811/`. |
| 7 | Partial; bounded foreground browser scope verified | Worker/WASM, foreground lifecycle, route ownership, stores, fake-media/emulation, bundle, and copy gates pass. Real microphones, acoustics, actual devices, hosted Firefox/Safari microphone use, approved packs, and release proof remain open. Receipt: `reports/native-voice/phase7-reverify-20260812/`. |
| 8 | Partial; bounded Linux desktop scope verified | A real current-source Tauri/CPAL path passed completed, hidden-window tray, and cancelled turns using paced virtual ALSA PCM and a loopback fake Gateway. This is not physical-microphone, acoustic, fully closed-UI, real-sidecar, remote-peer, cross-OS, or signed-release proof. Receipt: `reports/native-voice/phase8-reverify-20260812/`. |
| 9 | Partial; Linux source policy verified | Five Android policy files pass 40 tests. No ADB device was attached; no QEMU run or physical-device claim was made. Receipt: `reports/native-voice/phase9-10-reverify-20260812/`. |
| 10 | Partial-withheld; Linux source policy verified | Default-assistant/background entry remains disabled. Device/OEM lifecycle, accepted-wake resource behavior, endurance, and Play review remain open. Receipt shared with Phase 9. |
| 11 | Partial/blocked; Linux source policy verified | Three source-policy scripts, eight focused tests, and `ios:policy` pass. Xcode, simulator, WKWebView runtime, physical devices, signing, distribution, and App Review remain open. Receipt: `reports/native-voice/phase11-reverify-20260812/`. |
| 12 | Partial; bounded product surfaces verified | Redacted support export, typed `AdminAction` voice management, truthful disabled model operations, focused copy/lifecycle/storage tests, and typechecks pass. Complete provider mutations, model lifecycle, live-device persistence, data migration/deletion, and native hosting remain open. Receipt: `reports/native-voice/phase12-reverify-20260812/`. |
| 13 | Partial-blocked; static release gates verified | Release trust is bound to the dependency inventory and current source; static rollback/artifact/docs gates pass. The live inventory and trust report correctly block release. Signed artifacts, updater configuration, legal/security/store approval, runtime rollback, physical devices, staged rollout, and production packs remain open. Receipt: `reports/native-voice/phase13-reverify-20260812/`. |

## Current validation evidence

- Python PocketTTS/contracts/Gateway/script slice: 285 passed; SDK/backend conformance passed with 268 methods and zero fatal/generated/type issues.
- Rust 1.88 locked workspace: 314 passed, zero failed, one opt-in live-CPAL test ignored because no eligible device/environment was present.
- Android: five source-policy files, 40 tests passed; `adb devices -l` returned no devices; QEMU was not started.
- iOS: three source-policy scripts, eight focused tests, and `ios:policy` passed on Linux; no Xcode/runtime/device claim.
- Phase 12 UI/Tauri/shell: 432 focused assertions passed across 28 files plus filtered shell coverage; both UI and Tauri typechecks passed.
- Phase 13 release policy: four files, 120 tests passed; static rollback passed 5 groups, 23 operations, and 38 references with `runtimeProof: false`; `make check-docs` passed 71 Markdown files.
- Scoped independent review of the release trust/inventory hardening found zero remaining findings after repair. This is not overall security approval.
- GitNexus staged detection for the Phase 12/13 receipts was low risk with zero indexed changed symbols and zero affected processes.

## Durable receipt hashes

- Phase 8: `a272dc97e823f8e70ae8dbb168fbbf790b12e9f92aadba8f2179afcadbd8ee1a`
- Phases 9-10: `d91b27bf595f48f704827140e80ed11b37d87c898a3c9e5f1429e50d394bf36a`
- Phase 11: `6c28c2e8101aca32ac20923b95c760f8e0cae536c348374b852b150d7a38fe12`
- Phase 12: `6f3fda17c144a76d0f6d7f593f91ec41ffc84ef8c5750b4f0e7b9d57a85a682f`
- Phase 13: `d3cfa4a392384a12c03447af5a3466b5fc828dcac62951d6bac20da8a32e2490`

## Release boundary

The final live dependency inventory contains 1,845 entries: 758 Cargo, 676
npm, 24 Phase-4 assets, and 387 Python entries. All 676 npm entries carry
exact SHA-512 lockfile digests. Release remains blocked by 224 unresolved
licenses, 242 blocked dispositions, and a user-owned dirty root `package.json`.
The trust gate also blocks on placeholder updater configuration, absent
Android/iOS release artifacts, and missing signing/store evidence.

Inventory report SHA-256:
`6c4c31ac435226f1bee2524a7e22b87f1953f6378726678339c6d4154a2e537a`.
Trust report SHA-256:
`0f3e28e4b0581aa753fe2fbf40c6cca5109d66a941e8e2a32d22da871dc68b56`.

## RAC inventory

- Pass: RAC-02, RAC-03, RAC-04, RAC-05, RAC-07, RAC-09, RAC-10, RAC-13, RAC-14, RAC-16, RAC-17, RAC-18, RAC-21, RAC-23, RAC-24, RAC-26, RAC-29, RAC-42, RAC-46, RAC-47, RAC-48, RAC-55.
- Partial: RAC-01, RAC-06, RAC-08, RAC-11, RAC-12, RAC-19, RAC-20, RAC-22, RAC-25, RAC-27, RAC-28, RAC-30, RAC-31, RAC-33, RAC-34, RAC-38, RAC-39, RAC-45, RAC-49, RAC-50, RAC-51, RAC-52, RAC-53, RAC-54, RAC-56.
- Withheld: RAC-15, RAC-35, RAC-37, RAC-43, RAC-44.
- Blocked: RAC-32, RAC-36, RAC-40, RAC-41.

## Non-negotiable invariants

- Runtime `roles` are persisted dynamic profile state. Never derive them from environment variables, APK/build flavor, platform, transport, sidecar presence, or runtime tier.
- One client bundle may act as a thin client or node according to runtime roles.
- Pure web remains foreground-only.
- Installed WebViews never own durable background capture or native inference.
- `Tooling.ExecuteTool` is only a shared DataChannel regression canary, never voice acceptance evidence.
- Product UI must not expose engineering or verification vocabulary.
- Unavailable production speech capabilities remain false.
- Do not stage, rewrite, or discard unrelated user work in the dirty tree.
- Do not push unless the user explicitly requests it.

## Completion and continuation boundary

This normal Goal can close after the RAC and handoff synchronization is
validated and committed because all feasible repo-local work requested for this
run is implemented and verified. A future release-qualification Goal should
start only when new assets, clean dependency inputs, macOS/Xcode, eligible
Android/iOS devices, signing/store authority, or legal/security evidence are
available. It must preserve every withheld capability until its explicit gate
passes.
