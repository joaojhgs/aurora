# Native/WASM voice release goal capsule

Updated: 2026-08-15 UTC

## Authority

- Authoritative plan: `.omx/plans/pockettts-cross-surface-local-voice-plan.md`.
- Authoritative RAC tracker: `reports/native-voice/native-voice-rac-matrix.json`.
- Continuation handoff:
  `.omx/state/pockettts-native-voice-fresh-session-handoff.md`.
- Branch: `codex/full-voice-release`.
- Implementation/evidence head before this state sync:
  `6c88fea6bdf850acc6dd908fa052f903894b7443`.
- Plan SHA-256:
  `c1ba520fc5745f773d286f486f2f3890665ab2536d8039d1620c9638171f7eb7`.
- No push was performed.

## Release objective and disposition

The original Phase 0-13 objective is immutable: all features, platforms, UI
surfaces, and runtime roles remain in scope. Repo-local production capability
implementation is complete, and every unsigned package this Linux host can
build has been produced. Missing foreign hosts, physical devices, acoustic
labs, or official signing/store credentials are qualification or publication
dependencies; they are not removed features.

VAD, KWS, STT, and TTS are enabled production capabilities after the exact
user-selected assets are installed. Speech catalogs are metadata-only. No
model or voice weights are committed or embedded in packages. The client
downloads, verifies, privately caches, reuses, and can remove the user's exact
language/model/voice selection. Catalog support is data-driven rather than
restricted to a hardcoded shortlist.

There is no outstanding product, catalog, language, model-pack, legal-policy,
or user decision blocking repo-local implementation or unsigned packages.

## Platform and role matrix

| Surface | Production capability | Package/qualification status |
| --- | --- | --- |
| Desktop local | Native focused and background ownership; local or typed routed VAD/KWS/STT/TTS; on-demand private asset cache; tray/lifecycle behavior. | Linux client/local AppImage and DEB built. Windows/macOS native builds and host behavior require those hosts. |
| Desktop thin | Same client and UI with persisted runtime roles and remote typed routes; no build-time role. | Linux package built and tested; Windows/macOS remain host-qualified work. |
| Pure web | Foreground/focus-bounded microphone, Rust/WASM orchestration, VAD/KWS/STT/TTS, on-demand browser-private cache, clean lifecycle stop. | Web archive built; physical/acoustic and real browser/device microphone matrix remains external. |
| Android | Focused PTT, native/background runtime, foreground service with notification and Stop, optional default-assistant entry, native mic ownership, exact selected-pack cache, typed routes. | Unsigned x86_64 and arm64 APKs plus dual-ABI AAB built. Physical ARM64/OEM lifecycle and resource qualification remains external. |
| iOS | Native Sherpa VAD/KWS/STT/TTS feature, focused PTT, App Intents, and user-started visibly indicated background audio boundary; exact selected-pack cache. | Source and Linux-prepared frontend/config archive complete. Xcode build, simulator, device, and Apple lifecycle proof require macOS. |
| Python/headless node | Existing typed provider/configuration/routing paths, Piper/PocketTTS support, and remote or compatibility ownership. | Preserved and contract-tested. |

## Phase inventory

| Phase | Disposition |
| --- | --- |
| 0-3 | Preserved and integrated provider/configuration/contracts/routing/security baseline. |
| 4-5 | Shared Rust/native/WASM voice architecture, target portability, storage, ownership, cancellation, and generated-contract foundation complete. |
| 6 | Metadata-only on-demand multilingual model/voice catalogs and exact-selection cache complete. Historical bundled-pack approval gates are superseded. |
| 7 | Foreground web implementation complete; real hardware/acoustic/browser qualification external. |
| 8 | Desktop native implementation complete; Linux unsigned packages complete; Windows/macOS host qualification external. |
| 9 | Android focused runtime and unsigned APK/AAB packaging complete; physical-device qualification external. |
| 10 | Android background/default-assistant code complete; device/OEM lifecycle and endurance external. |
| 11 | iOS native/PTT/App Intents/user-started background boundary complete; Xcode/device packaging and runtime external. |
| 12 | Cross-surface end-user UI, admin/support, model/voice management, and clone-profile transfer complete. |
| 13 | Unsigned Linux/web/Android artifacts and iOS preparation complete; official signing/updater/store and live rollout/rollback deferred. |

## Current verification evidence

- `make check-rust-voice`: strict format/clippy passed; 385 native host tests
  and 31 WASM tests passed; two live-device/eligible-device cases ignored.
- Native Sherpa feature checks passed for core and native integration scopes.
- `make check-sdk-backend-contracts`: passed with 271 backend methods and zero
  fatal issues.
- Tauri typecheck passed; full Tauri suite: 478 passed, 15 skipped.
- Shared UI suite: 787 passed.
- Web voice typecheck and 184 tests passed.
- SDK: 691 passed in the parallel suite; the only contention timeout passed
  4/4 in isolation, covering the 692-case behavior set.
- Dependency inventory/trust tests: 84 passed.
- Live dependency inventory passed with 1,851 entries: 764 Cargo, 676 npm,
  24 pinned native voice assets, and 387 Python. Dispositions are 1,606 allowed
  and 245 review-required; package integrity/source/tool/redaction blockers are
  zero. Legal approval is explicitly not claimed.
- Static rollback policy passed. Runtime rollback proof remains false until a
  real deployment drill is run.
- `make check-docs` passed 71 Markdown files before this state sync.

## Unsigned artifact hashes

| Artifact | SHA-256 |
| --- | --- |
| Linux client AppImage | `3299382c1f0a9bb9a942c0f6e894590329be4eca120d70bd736c3710f566e0b7` |
| Linux client DEB | `785465dcf55c9ab67771eeb9d9e59ac29fec46f8ec23cadbb42931d608dc9bee` |
| Linux local AppImage | `1e64b380bd697a20ffc5dddfbb697afe61b1337a87d0b6dd00d64593bd1f6f67` |
| Linux local DEB | `405bd40e03c62d5b38134dbf8bd38eb617a07dac3ffbd021a86d4337fa648d0c` |
| Web archive | `4ba2c27caca0781166e4a8a588e7005b113efd04cea523a727cb75e7dd420d79` |
| Android x86_64 APK | `bd70772f9ae8031081faf534317ac33095c23aeb55cb9415052fed64dbf945db` |
| Android arm64 APK | `caec36a4d39c7cd325a3414ddb346a453b7558767afd4c4e22a289d8bf377227` |
| Android arm64+x86_64 AAB | `5bbd32ccb082ce84dd16d36acff2ce62b52930f00d7055229055f8e257315662` |
| iOS Linux-prepared frontend | `5ed758655b46039319aabe241d8e0e6f04e6ea2c652141b420c56c7054c4ada6` |

Artifact proof scanners passed. No model or voice weights were bundled.

## RAC inventory

The synchronized disposition is **24 pass / 30 partial / 0 withheld / 2
blocked**. Only RAC-36 and RAC-40 remain blocked because they require physical
Android hardware. Partial rows name external host, device, acoustic, or
official-release qualification still outstanding; partial does not mean the
feature was removed or left disabled.

- Pass: RAC-02, RAC-03, RAC-04, RAC-05, RAC-07, RAC-09, RAC-10, RAC-11,
  RAC-13, RAC-14, RAC-15, RAC-16, RAC-17, RAC-18, RAC-21, RAC-23, RAC-24,
  RAC-26, RAC-29, RAC-42, RAC-46, RAC-47, RAC-48, RAC-55.
- Partial: RAC-01, RAC-06, RAC-08, RAC-12, RAC-19, RAC-20, RAC-22, RAC-25,
  RAC-27, RAC-28, RAC-30, RAC-31, RAC-32, RAC-33, RAC-34, RAC-35, RAC-37,
  RAC-38, RAC-39, RAC-41, RAC-43, RAC-44, RAC-45, RAC-49, RAC-50, RAC-51,
  RAC-52, RAC-53, RAC-54, RAC-56.
- Blocked: RAC-36, RAC-40.

## True external qualification and publication boundary

1. Physical Android ARM64 locked/background/default-assistant/permission/Stop/
   Doze/call/Bluetooth/battery/thermal/OEM/endurance evidence.
2. macOS/Xcode iOS simulator and physical-device build/runtime evidence.
3. Windows and macOS desktop native package, audio, tray, lifecycle, updater,
   and rollback evidence.
4. Physical multilingual acoustic, accent, noise, false-wake, latency, memory,
   battery, thermal, and endurance evidence.
5. Later signing, notarization, updater, store credentials, submission, and
   review authority.
6. Live rollback, restore, canary, and staged-rollout drills.

## Non-negotiable invariants

- Runtime roles are persisted dynamic profile state, never build-time or
  platform-derived assignments.
- One client bundle can act as a thin client or node according to those roles.
- Pure web remains foreground/focus bounded.
- Installed WebViews never own durable background capture or native inference.
- User-facing UI never exposes internal engineering/test language.
- `Tooling.ExecuteTool` is a transport canary, not voice acceptance evidence.
- Do not push unless explicitly requested.

## Stop and continuation condition

Repo-local implementation and Linux-host unsigned packaging are complete.
Continue with external qualification when the relevant host/device exists, and
with official release operations only when signing/updater/store authority is
provided. Do not reopen catalog, language, bundled-pack, legal-approval, or
“keep speech disabled” decisions: they are not blockers under the current
metadata-only, exact-selection, on-demand download/cache policy.
