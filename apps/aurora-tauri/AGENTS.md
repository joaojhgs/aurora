# Aurora Tauri UI Development Guide

This guide applies to `apps/aurora-tauri/**`. It supplements the repository-root `AGENTS.md`; the root architecture, security, UI copy, service/tool naming, and verification contracts still apply.

In this guide, **UI work** includes the Tauri React application, desktop and mobile shells, route/runtime selection, hosted-client behavior exercised by this package, native Android/iOS integration, WebRTC, mesh pairing, reconnect/revocation, and the test harnesses that prove those paths.

## Fast, Evidence-Preserving Development

Optimize for the smallest check that can disprove the current change, followed by broader checks only at meaningful gates. Do **not** run the complete cross-platform E2E matrix after every edit. Targeted iteration checks never replace the final clean-room validation gate.

Use this progression:

1. **Edit loop** — affected unit/component test and the narrowest relevant typecheck.
2. **Coherent-slice gate** — affected package suite plus one boundary test when the change crosses UI, SDK, native, or Python boundaries.
3. **Surface gate** — targeted live test only on surfaces affected by the slice.
4. **Release-candidate gate** — clean state, complete required local matrix, artifact build, then remote macOS/iOS CI.

Do not move to a broader gate while a narrower check is failing. Diagnose the first failure instead of repeatedly rerunning the same long command.

## Change-to-Test Routing

### Presentation-only React or CSS changes

Run the affected component/route test and `@aurora/tauri-ui` typecheck. Inspect the changed page through the development server or Tauri development mode. Do not rebuild an APK, clear application data, or rerun pairing/WebRTC unless the change affects layout during those flows.

### Shared UI behavior or surface detection

Run the affected `@aurora/ui` tests, affected Tauri route tests, and typechecks for every changed consumer. Add web tests when behavior is shared with hosted web. Validate all surface profiles touched by the capability flag; do not infer mobile correctness from desktop jsdom tests.

### Assistant, Mesh, Tools, navigation, or persistence behavior

Run tests for the changed page and its state owner first. Then run the narrow route/runtime scenario covering the affected behavior. Preserve canonical shared components across desktop, web, Android, and iOS; responsive layout changes do not justify parallel mobile-only product flows.

### Pairing, scopes, reconnect, revocation, mesh routing, or WebRTC

Run targeted SDK and Python gateway/auth tests before live-device E2E. Then run only the affected live lane during iteration. Run the aggregate WebRTC matrix and real clean-state pairing journey at the coherent-slice or release-candidate gate.

Never weaken fail-closed assertions, authorization checks, transport isolation, manifest evidence, redaction checks, retry/reconnect expectations, or revocation checks to make a harness pass.

### Native shell, Rust, Android/iOS plugin, manifest, or packaging changes

Run native preflight and artifact-specific tests. Rebuild the affected native artifact. A frontend-only TypeScript/CSS change should normally use hot reload and should not pay the native packaging cost until the release-candidate build.

## Preferred Targeted Commands

Run commands from the repository root unless a script requires otherwise.

```bash
# Tauri UI typecheck and targeted tests
pnpm --filter @aurora/tauri-ui typecheck
pnpm --filter @aurora/tauri-ui exec vitest run --environment jsdom <test-file> -t "<scenario>"

# Shared UI / SDK boundaries when changed
pnpm --filter @aurora/ui typecheck
pnpm --filter @aurora/ui exec vitest run <test-file>
pnpm --filter @aurora/client typecheck
pnpm --filter @aurora/client exec vitest run <test-file>

# Targeted Python boundary
uv run pytest <relevant-test-file> -q

# Android live lanes
pnpm --filter @aurora/tauri-ui android:smoke
pnpm --filter @aurora/tauri-ui android:webrtc:webview
pnpm --filter @aurora/tauri-ui android:webrtc:mobile-browser

# Run only at the WebRTC slice/final gate
pnpm --filter @aurora/tauri-ui android:webrtc:interop

# Desktop live client/thin surface
pnpm --filter @aurora/tauri-ui test:desktop-client:live
```

Use existing package scripts rather than duplicating their setup logic. When selecting a test manually, keep its required environment (`node` versus `jsdom`) consistent with the package script.

## Keep the Iteration Environment Warm

- Keep the Vite/Tauri development server alive across frontend iterations.
- Keep reusable MQTT/TURN fixtures and non-conflicting local services alive across related scenarios when the harness supports reuse.
- Reuse the installed application and paired state unless the behavior under test is installation, onboarding, pairing, migration, revocation, or persistence recovery.
- Clear Android/iOS application data only when clean-state behavior is part of the claim.
- Rebuild/reinstall native artifacts only after native inputs change or at the release-candidate gate.
- Use stable emulator/device targets and fixed, explicit reverse ports. Do not switch to a physical device when an emulator is the declared test target.
- Run independent package tests/typechecks concurrently when they do not share mutable fixtures. Run live scenarios sequentially on one emulator and never overlap tests that share application data, ports, MQTT rooms, or native processes.

Warm iteration state is a speed optimization, not release evidence. The final gate must repeat required journeys from deterministic clean state.

## Fail Fast Before Long E2E Runs

Before starting a live mobile test, verify the prerequisites that can fail immediately:

- ADB/device is connected and authorized.
- Expected application and browser packages exist.
- The correct activity can launch and WebView debugging is reachable.
- Required artifact exists and matches the intended build.
- Reverse ports are installed.
- Required MQTT/TURN/Python endpoints are ready.
- Ports expected to be unavailable for an isolation assertion are actually free.
- Generated browser bundles contain no unresolved bare imports unless a matching import map is served.

Use phase-specific deadlines instead of one long blind timeout. Distinguish page/bundle load, signaling, DataChannel creation, pairing, manifest exchange, and scenario completion. On the first failed phase, collect diagnostics immediately and stop the scenario.

For live failures, capture at minimum:

- failing phase and elapsed time;
- current activity/window and device identity;
- actionable browser/WebView exception;
- relevant network requests and selected transport path;
- bounded logcat and service-log tail;
- screenshot when the failure is visual or interaction-related;
- redacted result artifact.

Classify the failure as product, harness, environment, or test-data state before editing product code. Known harness warnings may be ignored only through a narrow allowlist backed by a regression test; never discard arbitrary console errors.

## Clean-Room Release-Candidate Gate

Run the expensive matrix once the intended code is stable, and repeat it only after a fix that can affect its result. The final gate includes, as applicable:

1. Full affected frontend package tests, typechecks, lint, and builds.
2. Full required Python unit/integration checks for changed gateway/auth/mesh boundaries.
3. Fresh native artifact build and artifact verification.
4. Clean application data and cold-start onboarding.
5. Bilateral pairing with scope selection, delayed approval, retry without duplicate requests, reconnect without reapproval, and revocation fail-closed behavior.
6. Mesh service-sharing UI and Tools inventory/group/policy UI on the real surface.
7. Assistant local and Dispatch execution, remote peer model selection, conversation persistence, canonical tool-call rendering, scrolling, composer, history, navigation, and safe-area behavior.
8. Android packaged WebView and standalone-browser WebRTC evidence.
9. Hosted web client/node management and desktop local/client live paths affected by the change.
10. One final push followed by macOS/iOS build, simulator, smoke, and WebRTC jobs when those platforms are in scope.

After a release-gate failure, rerun the smallest reproducer while fixing it. When green, rerun the failed gate and every downstream gate affected by the fix; do not restart unrelated completed gates unless the fix crosses their shared boundary.

## Evidence Discipline

For each completed gate, retain a concise record of:

- exact command and exit status;
- source commit or dirty-tree digest;
- artifact path and SHA-256 when an artifact was exercised;
- emulator/device, OS/WebView/browser identity;
- scenario and transport lane;
- passed assertions and explicit skips;
- redacted report/log/screenshot locations;
- known gaps.

Capture detailed artifacts on failure and final release evidence on success. Do not accumulate redundant reports from unchanged reruns, do not treat generated artifacts as source changes, and clean transient output before committing.

Completion means the final claims are backed by fresh evidence from the appropriate surfaces—not that every expensive test ran after every small edit.
