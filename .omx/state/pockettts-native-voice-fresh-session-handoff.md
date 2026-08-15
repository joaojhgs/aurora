# Native/WASM voice release continuation handoff

Updated: 2026-08-15 UTC

## Start here

The full Phase 0-13 objective remains in scope. The repo-local implementation
and the unsigned packages this Linux host can produce are complete on
`codex/full-voice-release`. Do not revive the obsolete policy that kept VAD,
KWS, STT, or TTS disabled, required an Aurora-approved bundled pack, or treated
license review as a blocker for assembling unsigned packages.

1. Read `.omx/plans/pockettts-cross-surface-local-voice-plan.md`, this handoff,
   the goal capsule, and `reports/native-voice/native-voice-rac-matrix.json`.
2. Verify the plan SHA-256 is
   `c1ba520fc5745f773d286f486f2f3890665ab2536d8039d1620c9638171f7eb7`.
3. Treat `6c88fea6bdf850acc6dd908fa052f903894b7443` as the implementation
   and release-policy evidence head before this state synchronization.
4. Preserve the platform and runtime-role invariants below.
5. Continue only the external qualification or official-release work that the
   available host, hardware, or credentials can actually prove.

## Current product truth

- VAD, KWS, STT, and TTS are production capabilities on every applicable
  surface and runtime role. They become usable after the user selects and the
  client installs the required assets; they are not bundled or installed by
  default.
- Speech catalogs contain metadata, not model or voice weights. The code
  downloads, verifies, and privately caches the exact language/model/voice pack
  the user chooses. Cached assets remain available for later offline use.
- Catalog language support is data-driven. There is no product-level short
  allowlist restricting the catalog to a few languages.
- The same catalog, selection, installation, cache, ownership, and typed route
  semantics apply to desktop-local, desktop-thin, web, Android, iOS, and
  node/server roles subject to each surface's honest lifecycle boundary.
- Pure web is foreground/focus bounded. Installed native surfaces own durable
  capture and native inference when background operation is supported; their
  WebViews do not own background microphones or duplicate models.
- Runtime roles are persisted profile state. They are never inferred from an
  environment variable, build flavor, physical platform, transport, sidecar,
  or runtime tier.
- No product, catalog, language, model-pack, legal-policy, or user choice is
  blocking repo-local implementation or unsigned package assembly.

## Phase disposition

| Phase | Current result |
| --- | --- |
| 0-3 | Preserved provider, configuration, contract, routing, authorization, redaction, SDK, and peer-host foundations. |
| 4-5 | Shared Rust/native/WASM architecture and portability foundation complete, including one ownership/state-machine contract and native/Web adapters. |
| 6 | Metadata-only, on-demand, verified, cached multilingual model/voice catalog implemented. Exact selected assets are installed instead of embedded. |
| 7 | Foreground web VAD/KWS/STT/TTS runtime, lifecycle, storage, routing, and browser behavior implemented. Real acoustic and browser/device qualification remains external. |
| 8 | Desktop-local and desktop-thin native voice paths implemented; Linux unsigned AppImage and DEB packages built for both roles. Windows and macOS packaging/runtime checks need those hosts. |
| 9 | Android focused/native voice, selected-pack installation/cache, routing, and unsigned x86_64/arm64 APK plus dual-ABI AAB packaging complete. Physical-device behavior remains external. |
| 10 | Android user-started background service, notification/Stop flow, and optional default-assistant path implemented. OEM lifecycle, Doze, calls, Bluetooth, battery, thermal, and endurance require devices. |
| 11 | iOS native Sherpa VAD/KWS/STT/TTS feature wiring, focused PTT, App Intents, and user-started background audio boundary implemented. Linux-prepared frontend/config package built; Xcode/runtime/device proof requires macOS. |
| 12 | End-user UI, admin/support lifecycle surfaces, redacted support export, voice/model management, and clone-profile transfer implemented across runtime roles. |
| 13 | Unsigned Linux, web, and Android artifacts built with hashes and provenance; iOS source/frontend preparation complete. Official signing, notarization, updater publication, stores, and runtime rollout/rollback remain later operations. |

## Fresh verification

- Rust voice gate: strict format/clippy passed; 385 host tests and 31 WASM
  tests passed, with two explicitly hardware-dependent tests ignored.
- Backend/SDK contracts: 271 backend methods, zero fatal issues.
- Tauri UI: typecheck passed; 478 tests passed, 15 skipped.
- Shared UI: 787 tests passed.
- Web voice: typecheck passed; 184 tests passed.
- SDK: 691 tests passed in the full parallel run; the single contention-only
  timeout passed 4/4 in isolation, covering all 692 cases.
- Release inventory/trust policy slice: 84 focused tests passed.
- Dependency inventory: 1,851 entries (764 Cargo, 676 npm, 24 pinned native
  voice assets, 387 Python); 1,606 allowed and 245 review-required; no package
  integrity/source/tool/redaction blocker. Legal approval remains unclaimed.
- Static rollback policy passed; runtime rollback remains an environment test.
- Documentation check passed across 71 Markdown files before this state sync.

## Unsigned package evidence

- Linux desktop client AppImage:
  `3299382c1f0a9bb9a942c0f6e894590329be4eca120d70bd736c3710f566e0b7`
- Linux desktop client DEB:
  `785465dcf55c9ab67771eeb9d9e59ac29fec46f8ec23cadbb42931d608dc9bee`
- Linux desktop local AppImage:
  `1e64b380bd697a20ffc5dddfbb697afe61b1337a87d0b6dd00d64593bd1f6f67`
- Linux desktop local DEB:
  `405bd40e03c62d5b38134dbf8bd38eb617a07dac3ffbd021a86d4337fa648d0c`
- Web archive:
  `4ba2c27caca0781166e4a8a588e7005b113efd04cea523a727cb75e7dd420d79`
- Android x86_64 APK:
  `bd70772f9ae8031081faf534317ac33095c23aeb55cb9415052fed64dbf945db`
- Android arm64 APK:
  `caec36a4d39c7cd325a3414ddb346a453b7558767afd4c4e22a289d8bf377227`
- Android arm64+x86_64 AAB:
  `5bbd32ccb082ce84dd16d36acff2ce62b52930f00d7055229055f8e257315662`
- iOS Linux-prepared frontend archive:
  `5ed758655b46039319aabe241d8e0e6f04e6ea2c652141b420c56c7054c4ada6`

Artifact-specific proof scanners passed, and no speech model or voice weights
are bundled in these packages.

## True external-only blockers

These do not remove or disable features. They limit what can be qualified or
officially published from this Linux workspace.

1. Physical Android ARM64 lifecycle and hardware proof: locked/background
   turns, default-assistant selection, permission revocation, Stop, Doze, calls,
   Bluetooth, battery, thermal, endurance, and OEM behavior.
2. macOS/Xcode iOS build and runtime proof: simulator, iPhone/iPad, audio
   session transitions, background lifecycle, App Intents, packaging, and
   Apple review-sensitive behavior.
3. Windows and macOS desktop package/runtime proof: native audio, tray,
   lifecycle, installer, updater, and rollback behavior on those operating
   systems.
4. Physical acoustic and performance qualification: microphones, speakers,
   supported languages, accents, noise conditions, false wake rate, latency,
   memory, battery, and thermal behavior.
5. Later official release authority: signing identities, notarization,
   updater keys/endpoints, store accounts, credentials, submission, and review.
6. Runtime rollback, restore, canary, and staged-rollout drills in a real
   distribution environment.

## Continuation order

1. Run Android qualification on a representative Pixel and at least one
   lower-memory/OEM device; use a CI-equivalent QEMU image for reproducibility.
2. Run iOS build/runtime qualification on a current macOS/Xcode host and
   representative iPhone/iPad devices.
3. Build and test Windows x64 and Apple-silicon macOS desktop packages on their
   native hosts.
4. Execute the multilingual acoustic, noise, accent, performance, battery, and
   endurance matrix using user-selected downloaded packs.
5. When official publication is requested, configure signing/updater/store
   identities, then run canary, rollback, and submission gates.

## Invariants

- Pure web remains foreground-only.
- Installed WebViews never own durable background capture or native inference.
- One bundle may act as a thin client or node according to persisted roles.
- Product UI stays free of engineering and test terminology.
- `Tooling.ExecuteTool` remains a transport canary, not voice behavior.
- Do not push unless explicitly requested.
