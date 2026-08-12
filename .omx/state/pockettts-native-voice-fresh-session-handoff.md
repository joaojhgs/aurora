# PocketTTS native/WASM voice continuation handoff

Updated: 2026-08-12T04:00:53Z

## Start here only for a materially new qualification run

The feasible repo-local implementation and bounded validation through Phases
4-13 is complete. Do not restart Phase 8 or replay the completed source-policy
lanes unless the implementation changes. The product release remains blocked;
continue only when new external evidence or authority is available.

1. Use a normal Codex Goal. Do not invoke or revive OMX Ultragoal.
2. Check out `feat/ui-multi-platform-integration` and preserve unrelated user work.
3. Read the revised plan, goal capsule, and RAC matrix in that order.
4. Verify the plan SHA-256 is `50181a35cd42e12a33f8b6b1b7131a875bcafcb5a9bcc63eac06c4370ef74ea6`.
5. Treat `280320191ae7efaf85f0a12d2e2c92ba452cd086` as the current implementation/evidence head before the final state-only sync; resolve the state-sync commit with `git log -1 -- .omx/state reports/native-voice/native-voice-rac-matrix.json`.
6. Keep production VAD, KWS, STT, and TTS false.
7. Never infer runtime roles from environment, build, platform, transport, sidecar state, or runtime tier.

## Current truth

- RAC totals: **22 pass / 25 partial / 5 withheld / 4 blocked**.
- Phases 4 and 5 are closed only for their bounded architecture/portability and shared-foundation scopes.
- Phase 6 is disposition-verified but partial-withheld; no release-eligible interoperable speech pack exists and TTS is unavailable.
- Phase 7 is bounded foreground-browser partial.
- Phase 8 is bounded Linux-desktop partial using virtual PCM and a fake Gateway, not physical/acoustic/real-sidecar/cross-OS release proof.
- Phases 9-10 have current Linux source-policy evidence; no Android device was attached and no QEMU run was claimed.
- Phase 11 has Linux source-policy evidence only; Xcode, simulator, device, signing, and review gates remain open.
- Phase 12 has bounded redacted support export, typed voice-management actions, truthful disabled model operations, and product-surface validation; provider/model/data lifecycle work remains partial.
- Phase 13 has fail-closed dependency inventory, trust, artifact, and static rollback gates; release remains blocked.

## Current durable receipts

- `reports/native-voice/phase4-reverify-20260811/`
- `reports/native-voice/phase5-reverify-20260811/`
- `reports/native-voice/phase6-disposition-20260811/`
- `reports/native-voice/phase7-reverify-20260812/`
- `reports/native-voice/phase8-reverify-20260812/`
- `reports/native-voice/phase9-10-reverify-20260812/`
- `reports/native-voice/phase11-reverify-20260812/`
- `reports/native-voice/phase12-reverify-20260812/`
- `reports/native-voice/phase13-reverify-20260812/`

## Fresh bounded validation

- Python PocketTTS/contracts/Gateway/scripts: 285 passed; SDK/backend conformance passed.
- Rust 1.88 locked workspace: 314 passed, zero failed, one live-device CPAL test ignored.
- Android source policy: five files, 40 tests passed; no attached ADB device; no QEMU start.
- iOS source policy: three scripts, eight tests, and `ios:policy` passed on Linux.
- UI/Tauri/shell: 432 focused assertions passed plus both typechecks.
- Release policy: four files, 120 tests passed; static rollback passed with `runtimeProof: false`; documentation check passed 71 Markdown files.
- Independent release trust/inventory review: zero remaining scoped findings after repair; not overall security approval.

## Release blockers

- Dependency inventory: 1,845 entries; 224 unresolved licenses; 242 blocked dispositions; user-owned dirty root `package.json`.
- Updater public key and endpoint remain placeholders.
- Android and iOS release artifacts and exact release hashes are absent.
- Signing, store distribution, legal review, independent security approval, runtime rollback, and staged rollout are absent.
- No eligible physical Android/iOS lifecycle, acoustic, endurance, battery, or thermal evidence exists.
- No approved release-eligible interoperable speech pack exists.

Live inventory SHA-256:
`6c4c31ac435226f1bee2524a7e22b87f1953f6378726678339c6d4154a2e537a`.
Live trust SHA-256:
`0f3e28e4b0581aa753fe2fbf40c6cca5109d66a941e8e2a32d22da871dc68b56`.

## Safe continuation order

1. Start from a clean committed tree without absorbing the current unrelated user changes.
2. Resolve dependency licenses/dispositions and regenerate the inventory.
3. Produce exact Android/iOS artifacts and hashes on eligible build hosts.
4. Validate Waydroid first for ordinary Android iteration; use CI-equivalent QEMU only when required and shut it down afterward.
5. Run physical Android and macOS/Xcode/iOS lifecycle matrices.
6. Add updater, signing, store, legal, and security evidence.
7. Prove runtime rollback and staged rollout.
8. Re-run release trust; promote only the exact gates that pass.

## Invariants

- Pure web remains foreground-only.
- Installed WebViews never own durable background capture or native inference.
- One APK or desktop bundle may act as a thin client or node according to persisted runtime roles.
- Product UI stays free of engineering/test wording.
- `Tooling.ExecuteTool` remains a transport canary, not voice behavior.
- No phase or RAC promotion without current-source durable evidence and independent verification.
- Do not push unless explicitly requested.
