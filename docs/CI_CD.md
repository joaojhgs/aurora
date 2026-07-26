# CI/CD Workflows

Aurora CI is organized around durable product lanes rather than one-off issue gates. Local commands and GitHub Actions should use the same package scripts where possible.

## Required CI lanes

| Workflow | Purpose | Main checks |
| --- | --- | --- |
| `quality.yml` | Fast static feedback. | Generated config check, docs hygiene, Ruff lint/format, TypeScript typechecks. |
| `python-tests.yml` | Backend unit/integration coverage. | Unit tests, non-process integration tests, Redis-backed process-mode integration tests. |
| `e2e.yml` | Executable cross-surface E2E evidence. | Mesh transport harness and redacted support-bundle artifacts. |
| `webrtc-interop.yml` | Live browser ↔ Python Gateway WebRTC interop. | Required Chromium/Firefox/WebKit direct matrix plus Chromium, Firefox, and Playwright-WebKit STUN/TURN with MQTT signaling, Python HTTP API disabled, strict browser availability, and uploaded redacted reports. |
| `frontend-sdk.yml` | TypeScript SDK, shared UI, web app, and Tauri frontend. | SDK tests/build, UI tests/build, accessibility/responsive/visual suite, web app tests/build, Tauri frontend tests/typecheck/build. |
| `sdk-backend-contract-conformance.yml` | Backend/SDK contract drift protection. | Generated backend inventory, SDK fixture/type conformance, SDK package checks. |
| `tauri-desktop.yml` | Desktop Tauri shell and sidecar packaging smoke. | Rust check, desktop-local sidecar/smoke lanes, and a Python-free WSS-only desktop-thin AppImage/deb build plus artifact proof. |
| `tauri-android.yml` | Android thin build and emulator smoke. | Android init, unsigned CI preflight, Python-free WSS-only x86_64 debug APK and universal debug AAB proof, plus API 35 emulator native payload smoke. The job installs compile SDK 36 and all four Android Rust targets required by the AAB. |
| `tauri-ios.yml` | iOS simulator baseline and thin-shell build. | Tauri iOS init, unsigned baseline simulator build, Python-free WSS-only thin simulator build, and Swift smoke tests for native entrypoints. |
| `tauri-ios-release.yml` | iOS policy/signing preflight. | Linux policy-only validation plus optional macOS signing dry run. |
| `performance.yml` | Scheduled/manual performance and resilience. | Python performance tests and SDK offline/reconnect/resilience checks. |
| `docker-build.yml` | Container and process-mode topology validation. | `docker-compose.process.yml` config validation, per-service image builds; pushes only on tags or explicit manual request. |
| `release.yml` | Manual semantic release. | Lightweight release readiness checks, optional semantic-release publication. |
| `required-check-aliases.yml` | Temporary branch-protection compatibility. | Emits low-cost success contexts for stale required checks until repository settings are updated to canonical workflow/job names. |

## Local equivalents

```bash
# Python quality and tests
make check
make check-docs
make unit
make integration
uv run pytest tests/unit/gateway tests/unit/services tests/unit/app/config -q
uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py -q
uv run pytest tests/performance -v

# TypeScript packages
pnpm install --frozen-lockfile
pnpm --filter @aurora/client test && pnpm --filter @aurora/client build
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
pnpm test:webrtc:interop
pnpm test:webrtc:turn
pnpm test:webrtc:browsers
WEBRTC_INTEROP_REQUIRE_ALL_BROWSERS=1 pnpm test:webrtc:browsers

# Tauri desktop/mobile profiles
pnpm --filter @aurora/tauri-ui prepare:sidecar:desktop-local-minimal
env AURORA_TAURI_ALLOWED_REMOTE_ORIGINS="wss://signaling.example.invalid" \
  AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only \
  pnpm --filter @aurora/tauri-ui build:bundle:thin
pnpm --filter @aurora/tauri-ui verify:bundle:desktop-thin
pnpm --filter @aurora/tauri-ui prepare:sidecar:local-cpu
env AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS="wss://signaling.example.invalid" \
  AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only \
  pnpm --filter @aurora/tauri-ui android:build:thin:apk
pnpm --filter @aurora/tauri-ui android:verify:thin:apk
env AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS="wss://signaling.example.invalid" \
  AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only \
  pnpm --filter @aurora/tauri-ui android:build:thin:aab
pnpm --filter @aurora/tauri-ui android:verify:thin:aab
```

### Tauri operator smoke commands

Use these commands when preparing or reproducing the production UI gate:

| Purpose | Command | Notes |
| --- | --- | --- |
| One-command desktop local stack | `pnpm --filter @aurora/tauri-ui tauri dev` | Interactive developer command. It configures threads mode, the loopback Gateway, and the managed Python sidecar automatically. |
| Desktop local smoke report | `pnpm --filter @aurora/tauri-ui dev:smoke` | Launches `tauri dev`, probes `/api/health`, `/api/registry`, `/api/services`, requires `[tauri]` and `[aurora][...]` logs, then writes `apps/aurora-tauri/reports/tauri-dev-smoke.json`. Use Xvfb on Linux CI. |
| Linux-safe aggregate UI smoke | `pnpm --filter @aurora/tauri-ui tauri:smoke:linux` | Delegates to `test:ci-regression-gates`, which runs route, assistant, admin, runtime, outcome, dev-bootstrap, native-evidence, and service-boundary gates without requiring a desktop WebView. |
| Packaged thin desktop smoke | `AURORA_TAURI_ALLOWED_REMOTE_ORIGINS="wss://signaling.example.invalid" AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only pnpm --filter @aurora/tauri-ui build:bundle:thin` then `pnpm --filter @aurora/tauri-ui verify:bundle:desktop-thin` | Python-free alias of `build:bundle:desktop-thin`; CI intentionally builds WSS-only with no HTTPS Gateway origin and fails artifact proof on Python/sidecar content or archive-inspection errors. |
| Android PR preflight | `pnpm --filter @aurora/tauri-ui android:init` then `pnpm --filter @aurora/tauri-ui android:preflight:ci` | Requires the generated Android project but not release signing secrets. |
| Android thin artifact proof | `AURORA_TAURI_ANDROID_ALLOWED_REMOTE_ORIGINS="wss://signaling.example.invalid" AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only pnpm --filter @aurora/tauri-ui android:build:thin:apk`, then the matching verify command; repeat with `aab` | Builds unsigned WSS-only debug thin APK/AAB artifacts with no Gateway origin and scans them for forbidden Python/sidecar content. |
| Android release preflight | `pnpm --filter @aurora/tauri-ui android:preflight:strict` | Requires generated Android project and signing inputs. |
| iOS policy baseline | `pnpm --filter @aurora/tauri-ui ios:policy` | Linux-safe policy/source check for shared WebView routing, device-only Keychain reconnect proof, nonsecret profile storage, least-privilege thin capabilities, and approved platform copy. It is not build/runtime evidence. |
| iOS thin simulator build | `AURORA_TAURI_IOS_ALLOWED_REMOTE_ORIGINS="wss://signaling.example" AURORA_TAURI_THIN_CONNECTION_MODE=webrtc-only pnpm --filter @aurora/tauri-ui ios:build:thin:simulator` | Requires macOS/Xcode. Generates a temporary WSS-only, Python-free `aurora-ios-thin` overlay with no Gateway origin, builds the shared WebRTC WebView simulator app, and writes `apps/aurora-tauri/reports/ios-thin-simulator-build-provenance.json`. |
| iOS build/preflight | `pnpm --filter @aurora/tauri-ui tauri ios init`, `pnpm --filter @aurora/tauri-ui tauri ios build`, `pnpm --filter @aurora/tauri-ui ios:preflight` | Requires macOS with Xcode and the generated iOS project. Simulator/device WebRTC and signing evidence remain separate gates. |
| Docs hygiene | `make check-docs` | Runs `uv run python scripts/check_docs.py`. |

### WebRTC interop commands

Use [`WEBRTC_LIVE_INTEROP_HARNESS.md`](WEBRTC_LIVE_INTEROP_HARNESS.md) for report schema and current proof boundaries. Current local reports prove direct, STUN, and forced-TURN sessions in Chromium, Firefox, and Playwright WebKit, with lane category taken from browser `RTCPeerConnection.getStats()` selected pairs. A matrix skip in an environment missing an optional browser runtime remains unproven, not a pass; required CI sets strict browser availability.

## Branch protection compatibility

GitHub branch protection can keep expecting old check names after workflow consolidation. `required-check-aliases.yml` is intentionally tiny and should be removed after the required checks are updated in repository settings to the canonical lanes above:

- `Quality / Python lint, format, and generated config`
- `Python Tests / Unit and integration tests`
- `Python Tests / Process-mode integration tests`

## What was intentionally removed

The repository no longer keeps one-off issue-specific gate generator workflows for release packaging, transport parity, multi-mode matrix generation, security/privacy report generation, or UI release preflight. Useful coverage from those scripts was preserved as normal tests, package scripts, or durable workflows above.

## Artifact policy

- Normal test evidence goes under package-local `reports/`, `tests/**/reports/`, or `.artifacts/**`.
- `@aurora/tauri-ui` outcome E2E writes static route render artifacts under `apps/aurora-tauri/reports/e2e-outcomes/`; these are CI review artifacts, not a substitute for later desktop/WebView screenshot smoke.
- `.omx/**` is reserved for agent/workflow state, not CI artifacts.
- CI may upload redacted reports and support bundles; it must not upload raw tokens, Redis URLs, API keys, unredacted mesh credentials, raw audio, or raw RAG records.

## Release and signing policy

Default desktop/mobile CI builds are unsigned and intended for validation only. Android pull-request CI uses `android:preflight:ci` after `android:init`: it requires the generated Android project but does not require keystore secrets. Package signing, notarization, App Store Connect, and Play upload remain explicit release operations requiring platform secrets; Android release readiness uses `android:preflight:strict`.

## Final quality gate structure

The final Tauri/web/mobile UI quality gate is an evidence bundle, not a checklist assertion. Record each item with the exact command, status, log path, and artifact path:

| Gate item | Required evidence |
| --- | --- |
| Verification commands | Current output for Python quality/tests, SDK/UI/Tauri tests, route E2E, WebRTC interop, desktop smoke, Android preflight/artifact proof, and iOS policy/build where platform access exists. |
| Screenshots and route artifacts | Route screenshots or `apps/aurora-tauri/reports/e2e-outcomes/` artifacts, plus desktop/WebView smoke screenshots when available. |
| Desktop-local sidecar proof | `apps/aurora-tauri/reports/tauri-dev-smoke.json` or equivalent log proving Gateway readiness and `[tauri]`/`[aurora][...]` output. |
| Mobile/platform proof | Android preflight, Android thin APK/AAB artifact proof, emulator/device report where available, and iOS policy/build/preflight logs. Mark local Android runtime smoke `pending KVM/device` when no emulator/physical device exists, and mark iOS full build/preflight `pending macOS/Xcode` if it has not run. |
| ai-slop-cleaner result | Path to the cleanup report and whether it found required changes. Do not infer success if the cleanup workflow did not run. |
| code-reviewer approval | Path or transcript for independent code-reviewer approval. Mark `pending` if not run. |
| architect clearance | Path or transcript for architecture invariant clearance. Mark `pending` if not run. |

Do not mark the aggregate production UI ultragoal complete while any required evidence is missing, stale, failed, or only represented by this documentation.
