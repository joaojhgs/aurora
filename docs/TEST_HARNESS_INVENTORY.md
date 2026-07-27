# Test and executable harness inventory

**Status:** Current source of truth

This document classifies Aurora's executable support scripts so they are not mistaken for disposable one-off tests. A script may remain a script when it owns process orchestration, artifact construction, migration, or report generation; durable assertions should live in pytest, Vitest, Playwright Test, or a checked `--check` command.

## Decision rule

- **Keep as an executable:** the file constructs an artifact, starts/stops external processes, performs a migration, or owns operator/CI orchestration.
- **Keep assertions in normal tests:** deterministic parsing, policy, redaction, protocol, and failure behavior should be importable and exercised by the normal test runner.
- **Use an E2E harness intentionally:** browser/Python, Docker, Tauri/WebView, Redis, signing, emulator, and multi-process claims require a runner that can own those dependencies.
- **Do not count source-string tests as runtime proof:** they protect wiring, but only an executed build/smoke/E2E command proves the external path.

No new executable reviewed in the multi-platform/WebRTC change set is orphaned. Each is reached by a package command, workflow, documented command, or discoverable test.

## Native desktop and mobile build tooling

| Executables | Current assertion/CI owner | Decision |
| --- | --- | --- |
| `apps/aurora-tauri/scripts/prepare-thin-bundle.mjs`, `build-desktop-thin-frontend.mjs`, `assert-thin-bundle-clean.mjs` | `desktop-thin-bundle-proof.test.ts`, `ci-native-evidence.test.ts`, package commands, and `tauri-desktop.yml` | **Keep as build/artifact tools.** They generate exact-origin Python-free overlays and inspect real bundles; converting the wrappers into test files would make the product build path less reusable. |
| `prepare-android-thin-bundle.mjs`, `build-android-thin-frontend.mjs`, `build-android-thin-bundle.mjs`, `assert-android-thin-artifact-clean.mjs`, `android-preflight.mjs`, `install-android-native-plugin.mjs`, and `android-emulator-smoke.mjs` | `android-thin-bundle-proof.test.ts`, `tests/android/android-emulator.e2e.test.ts`, `ci-native-evidence.test.ts`, package commands, and `tauri-android.yml` | **Keep.** Vitest covers deterministic policy/error paths and owns the emulator assertions; the scripts retain reusable build/CDP orchestration. Android CI executes the actual APK/AAB path and packaged WebView smoke. Physical/OEM behavior remains separate release evidence. |
| `prepare-ios-thin-bundle.mjs`, `build-ios-thin-frontend.mjs`, `build-ios-thin-bundle.mjs`, `ios-preflight.mjs`, `ios-simulator-smoke.mjs` | `ios-thin-bundle-proof.test.ts`, `ios-simulator-smoke.test.ts`, `ci-native-evidence.test.ts`, package commands, and the iOS workflows | **Keep.** Linux tests cover policy generation plus simulator-runner success/failure orchestration with stubbed platform commands. The macOS workflow executes the actual build, simulator install/launch, keep-alive, screenshot, log, and teardown path. Physical-device behavior remains separate evidence. |
| `prepare-sidecar.mjs`, `tauri-dev-smoke.mjs` | `tauri-dev-bootstrap.test.ts`, package commands, and the Xvfb desktop smoke lane | **Keep.** `prepare-sidecar` is packaging tooling. `tauri-dev-smoke` is already an executable smoke test because it owns Tauri/Python startup, readiness probes, log assertions, teardown, and its report. |

## Generators, checkers, and migrations

| Executable | Current assertion/CI owner | Decision |
| --- | --- | --- |
| `scripts/check_docs.py` | `make check-docs`, quality CI, and documentation maintenance rules | **Keep as a checker.** Its value is repository-wide policy enforcement rather than isolated unit behavior. |
| `scripts/generate_backend_inventory.py` | backend-inventory unit/output-guard tests and SDK/backend conformance CI | **Keep as a deterministic generator.** |
| `scripts/generate_mesh_security_surface_inventory.py` | `test_mesh_security_surface_inventory.py`, including schema, exact regeneration, and `--check` drift behavior | **Keep; already properly converted at the assertion layer.** |
| `scripts/generate_webrtc_protocol_fixtures.py` | `test_webrtc_web_thin_protocol_vectors.py` byte-for-byte regeneration plus Python/TypeScript vector consumers | **Keep; already properly converted at the assertion layer.** |
| `scripts/migrate_mesh_service_config.py` | migration-domain tests and a subprocess CLI safety test | **Keep as an operator command.** The destructive/reverse gates belong in the CLI while transforms remain unit-tested. |

## Mesh E2E harnesses

| Executable | Current assertion/CI owner | Decision |
| --- | --- | --- |
| `scripts/mesh_gap_e2e_harness.py` | `tests/e2e/test_mesh_gap_e2e_harness.py` and the consolidated `python-tests.yml` E2E command | **Keep; already a real E2E harness.** The script owns artifact/report generation while pytest owns assertions and discovery. |
| `scripts/mesh_policy_two_instance_harness.py` | `tests/e2e/test_mesh_policy_two_instance.py` and the consolidated `python-tests.yml` E2E command | **Keep; already a real E2E harness.** Thread-local and isolated Redis/BullMQ process variants are now explicit durable CI coverage rather than incidental full-suite discovery. |

## Browser and Python WebRTC interoperability

| Executable | Current assertion/CI owner | Decision |
| --- | --- | --- |
| `scripts/webrtc_interop_services.sh`, `webrtc_interop.sh`, `webrtc_interop_browser_matrix.sh` | root `test:webrtc:*` commands and `webrtc-interop.yml` | **Keep as orchestration.** They own Docker MQTT/TURN lifecycle, lane selection, environment transfer, cleanup, and artifact paths; those responsibilities do not become clearer inside a unit test. |
| `scripts/webrtc_interop_scan.py` | `tests/unit/scripts/test_webrtc_interop_scan.py` plus the live harness | **Keep; deterministic candidate-lane and secret/raw-candidate scanning is already unit-tested.** |
| `tests/e2e/webrtc_interop/browser-entry.ts`, `assertions.ts`, and `live-interop.spec.ts` | discoverable Playwright Test coverage inside the live Chromium/Firefox/WebKit direct/STUN/TURN workflow | **Converted.** The browser scenario remains an importable in-page helper, while Playwright Test now owns named steps and assertions for ICE selection, DataChannel RPC/events, reconnect, uncertain-loss at-most-once behavior, revocation, and absence of HTTP fallback. Shell/Docker orchestration stays outside the test. |
| `apps/aurora-tauri/tests/android/android-python-webrtc.e2e.test.ts` and `android-browser-python-webrtc.e2e.test.ts` | `android:webrtc:interop` and the existing API 35 emulator step in `tauri-android.yml` | **Keep as normal Vitest E2E tests.** They reuse the same browser entry/assertions against the packaged Android System WebView and standalone Android Chrome, start the external Python peer and signaling/relay fixtures, scan redacted reports, and clean up every process/ADB mapping. They intentionally share the existing Android check rather than producing per-assertion workflows. |
| `apps/aurora-tauri/scripts/run-android-webrtc-interop.mjs` | `apps/aurora-tauri/src/android-webrtc-interop-aggregate.test.ts` and `tauri-android.yml` | **Keep as tested orchestration/evidence aggregation.** The runner serializes both real mobile-peer E2Es, deletes stale child reports, emits one bounded fail-closed aggregate containing only booleans, allowlisted lane/category values, and SHA-256 digests, and returns nonzero unless both complete scanner reports pass. The pure aggregation contract is part of the normal Tauri unit suite; no extra CI workflow is needed. |
| `scripts/webrtc_interop_gateway.py` | live interop workflow plus `tests/unit/scripts/test_webrtc_interop_gateway.py` | **Keep the process driver; deterministic coverage added.** Pytest now covers registry digest/order, pairing and mutation bus behavior, canonical reconnect proof and revocation, candidate filtering, and redacted ready/final report assembly. `main()` remains responsible for the real Python peer and signaling lifecycle. |
| `tests/e2e/browser_persistence/browser-peer-persistence.spec.ts` | `pnpm test:web-persistence` and the cross-engine persistence job in `webrtc-interop.yml` | **Keep as a normal Playwright E2E test.** It is discoverable, cross-engine, reloads a real origin, exercises actual IndexedDB/CryptoKey cloning, and checks that persisted records contain no plaintext peer secrets. |

## Prioritized follow-up

1. Optionally add shell-level failure/cleanup tests for missing Docker/browser binaries. This is lower value because the live workflow already exercises the happy path and fails on nonzero exits.
