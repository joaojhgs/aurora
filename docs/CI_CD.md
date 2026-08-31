# CI/CD Workflows

Aurora CI is organized around durable product lanes rather than one-off issue gates. Local commands and GitHub Actions should use the same package scripts where possible.

## Required CI lanes

| Workflow | Purpose | Main checks |
| --- | --- | --- |
| `quality.yml` | Fast static feedback. | Generated config check, docs hygiene, Ruff lint/format, TypeScript typechecks. |
| `python-tests.yml` | Consolidated backend and Python E2E coverage. | Unit tests, non-process integration tests, Redis-backed process-mode integration tests, every discoverable Python E2E test, both mesh harnesses, and redacted support-bundle artifacts. |
| `webrtc-interop.yml` | Live browser ↔ Python Gateway WebRTC interop, hosted peer UI behavior, and browser credential persistence. | One consolidated required check runs Chromium/Firefox/WebKit encrypted IndexedDB refresh restoration, a hosted-Chromium full-service UI pairing/reload E2E, and a single shared Chromium/Firefox/Playwright-WebKit × direct/STUN/TURN matrix command with MQTT signaling, Python HTTP API disabled for the browser data path, strict browser availability, and uploaded redacted reports. |
| `frontend-sdk.yml` | TypeScript SDK, shared UI, web app, and Tauri frontend. | SDK tests/build, UI tests/build, accessibility/responsive/visual suite, web app tests/build, Tauri frontend tests/typecheck/build. |
| `sdk-backend-contract-conformance.yml` | Backend/SDK contract drift protection. | Generated backend inventory, SDK fixture/type conformance, SDK package checks. |
| `tauri-desktop.yml` | Desktop Tauri shell and sidecar packaging smoke. | Builds the pinned, Aurora-patched static Sherpa/ONNX Runtime for Linux, macOS, and Windows; runs Rust checks and desktop-local sidecar/smoke lanes; publishes separate Linux AppImage/DEB/RPM sets for the bundled minimal Python sidecar and Python-free client; and produces native macOS/Windows client packages. Legacy desktop-thin scripts delegate to the client commands. |
| `tauri-android.yml` | Android client build, emulator smoke, and mobile WebRTC interop. | Pull-request CI builds an x86_64 debug APK/AAB for emulator checks. Canonical releases reuse the same workflow but publish a stripped arm64 release APK and multi-ABI release AAB. API 30 and API 35 cover packaged UI/native payload and external-Python-peer WebRTC in the packaged System WebView and Android Chrome. Python is only the remote test peer and is never packaged. |
| `tauri-ios.yml` | iOS simulator baseline, client build, runtime smoke, and mobile WebRTC interop. | Builds the pinned, Aurora-patched static Sherpa/ONNX Runtime simulator runtime, then covers Tauri iOS init, unsigned Python-free client build, real simulator install/launch/screenshot/keep-alive evidence, Swift native-entrypoint smoke, and direct-path pairing/RPC/reconnect/revocation against an external Python peer in MobileSafari and a packaged Tauri WKWebView app. The Python HTTP API is disabled, and the packaged app is scanned for forbidden Python/sidecar paths. |
| `tauri-ios-release.yml` | iOS policy/signing preflight. | Linux policy-only validation plus an optional macOS signing dry run that builds the same pinned patched native voice runtime for an iOS device target. |
| `performance.yml` | Scheduled/manual performance and resilience. | Python performance tests and SDK offline/reconnect/resilience checks. |
| `docker-build.yml` | Container and process-mode topology validation. | Pull requests and manual runs validate every image without publishing. Only `release.yml` may invoke its reusable publish mode with the canonical semantic version. |
| `release.yml` | Canonical product release and version owner. | Computes one semantic version, applies it to Python/npm/Tauri/Cargo/SDK metadata, reuses desktop, Android, iOS, and container workers, builds standalone web and versioned server archives plus Python distributions, validates the complete package set before tag creation, and publishes normalized packages with a manifest and checksums. Dry-run is the default. |
| `sherpa-pockettts-language-packs.yml` | Temporary PocketTTS pack publisher. | `workflow_dispatch` or GitHub release only; converts English 2026-04 and French 24l packs and uploads checksummed artifacts. Remove the convert job after stable release URLs exist. |
| `required-check-aliases.yml` | Temporary branch-protection compatibility. | Waits for the canonical required jobs (`Quality / Python lint, format, and generated config` and `Python Tests / Unit, integration, and E2E tests`) and copies their conclusions into the stale check names. Unconditional success is not allowed. |

## Local equivalents

```bash
# Python quality and tests
make check
make check-docs
make unit
make integration
uv run pytest tests/unit/gateway tests/unit/services tests/unit/app/config -q
uv run pytest tests/e2e -q

# TypeScript packages
pnpm install --frozen-lockfile
pnpm --filter @aurora/mesh-authority-web build && pnpm --filter @aurora/mesh-authority-web test && pnpm --filter @aurora/mesh-authority-web typecheck
pnpm --filter @aurora/client build && pnpm --filter @aurora/client test && pnpm --filter @aurora/client typecheck
pnpm --filter @aurora/client test:resilience
pnpm --filter @aurora/ui test && pnpm --filter @aurora/ui test:accessibility && pnpm --filter @aurora/ui build
pnpm --filter @aurora/web test && pnpm --filter @aurora/web build
pnpm --filter @aurora/tauri-ui test && pnpm --filter @aurora/tauri-ui typecheck && pnpm --filter @aurora/tauri-ui build
pnpm --filter @aurora/tauri-ui test:e2e:routes
pnpm --filter @aurora/tauri-ui test:e2e:assistant
pnpm --filter @aurora/tauri-ui test:e2e:admin
pnpm --filter @aurora/tauri-ui test:e2e:runtime
pnpm --filter @aurora/tauri-ui test:e2e:outcomes
pnpm --filter @aurora/tauri-ui tauri:smoke:linux

# WebRTC live interop
pnpm test:web-persistence
pnpm test:hosted-peer:live
pnpm test:webrtc:interop
pnpm test:webrtc:turn
pnpm test:webrtc:browsers
WEBRTC_INTEROP_REQUIRE_ALL_BROWSERS=1 pnpm test:webrtc:browsers
# macOS/Xcode only; runs MobileSafari and packaged Tauri WKWebView in the existing iOS job
pnpm --filter @aurora/tauri-ui ios:webrtc:interop

# Tauri desktop/mobile profiles
python tools/voice-runtime/build_sherpa_native.py --target host --jobs 2
pnpm --filter @aurora/tauri-ui prepare:sidecar:desktop-local-minimal
pnpm --filter @aurora/tauri-ui build:bundle:desktop-client
pnpm --filter @aurora/tauri-ui verify:bundle:desktop-client
pnpm --filter @aurora/tauri-ui prepare:sidecar:local-cpu
pnpm --filter @aurora/tauri-ui android:build:client:apk
pnpm --filter @aurora/tauri-ui android:verify:client:apk
pnpm --filter @aurora/tauri-ui android:build:client:aab
pnpm --filter @aurora/tauri-ui android:verify:client:aab
```

### Tauri operator smoke commands

Use these commands when preparing or reproducing the production UI gate:

| Purpose | Command | Notes |
| --- | --- | --- |
| Patched desktop voice runtime | `python tools/voice-runtime/build_sherpa_native.py --target host --jobs 2` | Builds and verifies the pinned Sherpa/ONNX Runtime static archive set under ignored `.artifacts/`. Export the printed `AURORA_SHERPA_ONNX_LIB_DIR` and `AURORA_SHERPA_ONNX_LINK_KIND` values before a native Cargo/Tauri build. iOS targets are `aarch64-apple-ios-sim` and `aarch64-apple-ios` on macOS. |
| One-command desktop local stack | `pnpm --filter @aurora/tauri-ui tauri dev` | Interactive developer command. It configures threads mode, the loopback Gateway, and the managed Python sidecar automatically. |
| Desktop local smoke report | `pnpm --filter @aurora/tauri-ui dev:smoke` | Launches `tauri dev`, probes `/api/health`, `/api/registry`, `/api/services`, requires `[tauri]` and `[aurora][...]` logs, then writes `apps/aurora-tauri/reports/tauri-dev-smoke.json`. Use Xvfb on Linux CI. |
| Linux-safe aggregate UI smoke | `pnpm --filter @aurora/tauri-ui tauri:smoke:linux` | Delegates to `test:ci-regression-gates`, which runs route, assistant, admin, runtime, outcome, dev-bootstrap, native-evidence, and service-boundary gates without requiring a desktop WebView. |
| Packaged desktop-client smoke | `pnpm --filter @aurora/tauri-ui build:bundle:desktop-client` then `pnpm --filter @aurora/tauri-ui verify:bundle:desktop-client` | Python-free client artifact; legacy `*:thin` scripts delegate to these commands. CI intentionally builds with no compiled Gateway/signaling endpoint and fails artifact proof on Python/sidecar content, endpoint-specific CSP sources, or archive-inspection errors. |
| Android PR preflight | `pnpm --filter @aurora/tauri-ui android:init` then `pnpm --filter @aurora/tauri-ui android:preflight:ci` | Requires the generated Android project but not release signing secrets. |
| Android client artifact proof | `pnpm --filter @aurora/tauri-ui android:build:client:apk`, then the matching verify command; repeat with `aab` | Builds unsigned runtime-configurable debug client APK/AAB artifacts with no compiled Gateway/signaling endpoint and scans them for forbidden Python/sidecar content. |
| Android packaged-WebView UI/native smoke | `pnpm --filter @aurora/tauri-ui android:smoke` | Requires a running emulator/device and the built client APK. Installs/launches the real package, uses Chrome DevTools Protocol against its System WebView, validates the Android native redacted payload, rejects runtime/console errors, and checks the responsive mobile navigation/safe-area layout. CI runs it on API 30 and API 35 in the existing Android job. |
| Android WebView/mobile-browser ↔ Python WebRTC | `pnpm --filter @aurora/tauri-ui android:webrtc:interop` | Requires a running emulator/device, Docker, `uv sync --extra gateway`, and the built client APK. It starts MQTT/coturn plus an external Python `RTCClient`, then runs the shared protocol harness in both the packaged System WebView and standalone Android Chrome without CDP. Both consume the browser gate’s negotiation-direction, manifest, structured-error, 512 KiB fragmentation, stream/cancel, bilateral pairing, typed RPC/events, reconnect, uncertain-loss, revocation, redaction, and zero-Aurora-HTTP assertions. The Android workflow is configured to execute both sequentially on the KVM-backed API 35 emulator. The runner deletes stale child reports first and writes `apps/aurora-tauri/reports/webrtc-interop/android-aggregate-report.json`; it accepts that aggregate only when the command and both complete child reports pass, and the existing Android artifact upload is configured to include it without adding another workflow/check. The current repository does not retain a durable passing aggregate or standalone-Chrome child report, so a fresh successful run is still required for current evidence. |
| Android Waydroid mesh/background/assistant acceptance | Maintained Android live scripts after local suites pass | Uses one explicit Waydroid serial and the packaged application against the full `uv run python main.py` service. It owns local pairing/reconnect, background native ping/tool serving, ordered resume, force-stop/server-restart recovery, and assistant-turn evidence. Do not substitute a mock server. Rerun on an integration branch only for a substantial Android-native, Rust-session, SDK transport/pairing, foreground-service, or lifecycle delta. This never replaces physical-device Doze/OEM-kill/battery/thermal evidence. |
| Android release preflight | `pnpm --filter @aurora/tauri-ui android:preflight:strict` | Requires generated Android project and signing inputs. |
| iOS policy baseline | `pnpm --filter @aurora/tauri-ui ios:policy` | Linux-safe policy/source check for shared WebView routing, device-only Keychain reconnect proof, nonsecret profile storage, least-privilege thin capabilities, and approved platform copy. It is not build/runtime evidence. |
| iOS client simulator build | `pnpm --filter @aurora/tauri-ui ios:build:client:simulator` | Requires macOS/Xcode. Generates a temporary runtime-configurable, Python-free client overlay with no compiled Gateway/signaling endpoint, builds the shared WebRTC WebView simulator app, and writes `apps/aurora-tauri/reports/ios-client-simulator-build-provenance.json`. Legacy iOS thin scripts delegate to the client command. |
| iOS simulator runtime smoke | `pnpm --filter @aurora/tauri-ui ios:smoke:simulator` | Requires macOS/Xcode and a built simulator `.app`. Selects an available iPhone simulator, boots it when necessary, installs and launches the app, waits through a settle window, captures a screenshot and process-scoped log, rejects crash evidence, proves the app can still be terminated, and writes `apps/aurora-tauri/reports/ios-simulator-smoke.json`. |
| iOS MobileSafari and packaged WKWebView ↔ Python WebRTC | `pnpm --filter @aurora/tauri-ui ios:webrtc:interop` | Requires macOS/Xcode, Homebrew Mosquitto, and `uv sync --extra gateway`. One serial Vitest E2E file boots an iPhone simulator and runs the same external-Python direct-path contract twice: first in MobileSafari without Web Inspector/CDP, then in a dedicated unsigned Tauri WKWebView app built from an embedded test frontend with no sidecar resources. Both apply the shared negotiation, manifest, error, 512 KiB fragmentation, stream/cancel, bilateral pairing, scoped-event/TTS, reconnect, uncertain-mutation, revocation, HTTP-disabled, and redaction assertions. Reports stay separate under `ios-mobile-safari/` and `ios-wkwebview/`, but both execute in the existing iOS workflow/check. Loopback HTTP is test-control only; Aurora RPC/events remain on the DataChannel. This is simulator evidence, not physical-device direct/STUN/TURN certification. |
| iOS build/preflight | `pnpm --filter @aurora/tauri-ui tauri ios init`, `pnpm --filter @aurora/tauri-ui tauri ios build`, `pnpm --filter @aurora/tauri-ui ios:preflight` | Requires macOS with Xcode and the generated iOS project. Simulator/device WebRTC and signing evidence remain separate gates. |
| Docs hygiene | `make check-docs` | Runs `uv run python scripts/check_docs.py`. |

### WebRTC interop commands

Use [`WEBRTC_LIVE_INTEROP_HARNESS.md`](WEBRTC_LIVE_INTEROP_HARNESS.md) for report schema and current proof boundaries. Current local reports prove direct, STUN, and forced-TURN sessions in Chromium, Firefox, and Playwright WebKit, with lane category taken from browser `RTCPeerConnection.getStats()` selected pairs. A matrix skip in an environment missing an optional browser runtime remains unproven, not a pass; required CI sets strict browser availability.

`pnpm test:web-persistence` is a separate real-browser Playwright test. It builds the SDK/UI modules, stores a non-extractable AES-GCM key plus encrypted peer material in IndexedDB, reloads the page, and proves restoration in Chromium, Firefox, and WebKit without finding plaintext bearer or room secrets in IndexedDB/localStorage. It does not establish resistance to active same-origin XSS or a compromised browser profile.

`pnpm test:hosted-peer:live` is the hosted product-flow Playwright gate; `pnpm test:web-thin:live` remains a compatibility alias. Its runner starts isolated MQTT/TURN services, a temporary full Python thread-mode Auth/DB/Gateway/WebRTC node, and the Next hosted shell. Chromium imports a real invite through onboarding, compares the UI SAS with the Python pending pairing, completes bilateral non-admin approval, proves the scoped route surface and Mesh refresh over WebRTC, rejects browser Gateway HTTP fallback, preserves the SPA runtime across navigation and a dispatched blur event, verifies non-extractable AES-GCM IndexedDB envelopes with no plaintext room/reconnect material in browser storage, then reloads and reconnects without another pairing prompt. The test process uses an ephemeral admin API key only for server-side setup/approval/diagnostics; browser requests to that Gateway origin are asserted to remain empty. The blur assertion covers the former UI event-handler disconnect regression, not real OS tab suspension.

## Branch protection compatibility

GitHub branch protection can keep expecting old check names after workflow consolidation. `required-check-aliases.yml` waits for the canonical jobs below and fails if those jobs are missing, cancelled, or unsuccessful. Remove the alias workflow after the required checks are updated in repository settings to the canonical lanes above:

- `Quality / Python lint, format, and generated config`
- `Python Tests / Unit, integration, and E2E tests`

## What was intentionally removed

The repository no longer keeps one-off issue-specific gate generator workflows for release packaging, transport parity, multi-mode matrix generation, security/privacy report generation, or UI release preflight. Useful coverage from those scripts was preserved as normal tests, package scripts, or durable workflows above.

## Artifact policy

- Normal test evidence goes under package-local `reports/`, `tests/**/reports/`, or `.artifacts/**`.
- `@aurora/tauri-ui` outcome E2E writes static route render artifacts under `apps/aurora-tauri/reports/e2e-outcomes/`; these are CI review artifacts, not a substitute for later desktop/WebView screenshot smoke.
- `.omx/**` is reserved for agent/workflow state, not CI artifacts.
- CI may upload redacted reports and support bundles; it must not upload raw tokens, Redis URLs, API keys, unredacted mesh credentials, raw audio, or raw RAG records.

## Release and signing policy

Default desktop/mobile CI builds are unsigned. Android pull-request CI uses `android:preflight:ci` after `android:init`: it requires the generated Android project but does not require keystore secrets. Python installed in the Android and iOS simulator jobs is an external protocol peer used only by E2E tests; APK/AAB/iOS client artifact proof remains independently Python-free.

`release.yml` is the only product version and publication owner. It defaults to a non-publishing dry run, may publish only from `main`, and passes the same exact version to every reusable package workflow. Before semantic-release creates the tag, a package-set job downloads and validates every required artifact. The final release contains separate Linux AppImage/DEB/RPM sets for the Python-free desktop client and bundled minimal Python-sidecar desktop, macOS client DMG, Windows client MSI/NSIS, an arm64 Android APK, Android AAB, iOS simulator archive, standalone web archive, installable server archive, Python wheel/source distribution, `RELEASE-MANIFEST.json`, `SHA256SUMS`, `UNSIGNED-ARTIFACTS.txt`, and an exhaustive checksummed commit changelog. After deterministic assets and notes are published, a final best-effort GitHub Copilot CLI step appends a bounded AI overview from the complete commit-subject history. The AI output cannot supply artifact links or replace verified release data, and an unavailable or invalid AI response does not fail the release. Container images are published only after the GitHub package upload succeeds. CI worker artifacts expire and are not independent releases.

Current packages are intentionally unsigned: updater bundles are disabled, the iOS output is simulator-only, and no package is notarized, Play-uploaded, or App-Store-uploaded. The placeholder updater key and endpoint in the source configuration are deliberately inert in this lane: the unsigned trust-policy gate requires updater artifacts to remain disabled, while the signed gate rejects placeholder trust material and requires production HTTPS endpoints before updater artifacts can be enabled. `tauri-ios-release.yml` and `android:preflight:strict` retain credential-gated signing-policy checks for a later signed distribution lane, but they do not own versions or create releases. Sherpa PocketTTS language packs remain a separate specialized publisher because their model lifecycle is independent of product versions.

## Final quality gate structure

The final Tauri/web/mobile UI quality gate is an evidence bundle, not a checklist assertion. Record each item with the exact command, status, log path, and artifact path:

| Gate item | Required evidence |
| --- | --- |
| Verification commands | Current output for Python quality/tests, SDK/UI/Tauri tests, route E2E, WebRTC interop, desktop smoke, Android preflight/artifact proof, and iOS policy/build where platform access exists. |
| Screenshots and route artifacts | Route screenshots or `apps/aurora-tauri/reports/e2e-outcomes/` artifacts, plus desktop/WebView smoke screenshots when available. |
| Desktop-local sidecar proof | `apps/aurora-tauri/reports/tauri-dev-smoke.json` or equivalent log proving Gateway readiness and `[tauri]`/`[aurora][...]` output. |
| Mobile/platform proof | Android preflight, APK/AAB proof, named emulator/Waydroid report where applicable, physical-device report for power/survival claims, and iOS policy/build/preflight logs. Mark the exact missing device class or runner; Waydroid is not physical evidence, and Linux cannot replace macOS/Xcode iOS runtime jobs. |
| ai-slop-cleaner result | Path to the cleanup report and whether it found required changes. Do not infer success if the cleanup workflow did not run. |
| code-reviewer approval | Path or transcript for independent code-reviewer approval. Mark `pending` if not run. |
| architect clearance | Path or transcript for architecture invariant clearance. Mark `pending` if not run. |

Do not mark the aggregate production UI ultragoal complete while any required evidence is missing, stale, failed, or only represented by this documentation.
