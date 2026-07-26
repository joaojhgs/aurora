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
| `prepare-android-thin-bundle.mjs`, `build-android-thin-frontend.mjs`, `build-android-thin-bundle.mjs`, `assert-android-thin-artifact-clean.mjs`, `android-preflight.mjs`, `install-android-native-plugin.mjs` | `android-thin-bundle-proof.test.ts`, `ci-native-evidence.test.ts`, package commands, and `tauri-android.yml` | **Keep.** Vitest covers deterministic policy/error paths; Android CI executes the actual APK/AAB path. Emulator/physical-device runtime remains a separate E2E claim. |
| `prepare-ios-thin-bundle.mjs`, `build-ios-thin-frontend.mjs`, `build-ios-thin-bundle.mjs`, `ios-preflight.mjs` | `ios-thin-bundle-proof.test.ts`, `ci-native-evidence.test.ts`, package commands, and the iOS workflows | **Keep.** Linux tests cover policy generation and failure paths; only macOS/Xcode can prove the simulator/device build. |
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
| `scripts/mesh_gap_e2e_harness.py` | `tests/e2e/test_mesh_gap_e2e_harness.py` and `e2e.yml` | **Keep; already a real E2E harness.** The script owns artifact/report generation while pytest owns assertions and discovery. |
| `scripts/mesh_policy_two_instance_harness.py` | `tests/e2e/test_mesh_policy_two_instance.py`; also discovered by a full `make test` | **Keep; already a real E2E harness.** **P1 follow-up:** add this test explicitly to `e2e.yml` (or a separate slow multi-instance job), because the current durable E2E workflow invokes only the mesh-gap test file. |

## Browser and Python WebRTC interoperability

| Executable | Current assertion/CI owner | Decision |
| --- | --- | --- |
| `scripts/webrtc_interop_services.sh`, `webrtc_interop.sh`, `webrtc_interop_browser_matrix.sh` | root `test:webrtc:*` commands and `webrtc-interop.yml` | **Keep as orchestration.** They own Docker MQTT/TURN lifecycle, lane selection, environment transfer, cleanup, and artifact paths; those responsibilities do not become clearer inside a unit test. |
| `scripts/webrtc_interop_scan.py` | `tests/unit/scripts/test_webrtc_interop_scan.py` plus the live harness | **Keep; deterministic candidate-lane and secret/raw-candidate scanning is already unit-tested.** |
| `scripts/webrtc_interop_browser.mjs` and `tests/e2e/webrtc_interop/browser-entry.ts` | live Chromium/Firefox/WebKit direct/STUN/TURN workflow | **Keep the process launcher, partially convert the assertion layer.** **P1 follow-up:** extract the browser scenario into an importable helper used by both the current file-coordinated runner and a conventional Playwright Test spec. This improves per-step reporting/retries without losing Python/Docker coordination. |
| `scripts/webrtc_interop_gateway.py` | live interop workflow through `webrtc_interop.sh` | **Keep the process driver, add focused tests.** **P1 follow-up:** unit-test the deterministic `InteropRegistry`, `InteropBus`, `InteropAuth`, candidate filtering, and report assembly; retain `main()` for the real Python peer and signaling lifecycle. |
| `tests/e2e/browser_persistence/browser-peer-persistence.spec.ts` | `pnpm test:web-persistence` and the cross-engine persistence job in `webrtc-interop.yml` | **Keep as a normal Playwright E2E test.** It is discoverable, cross-engine, reloads a real origin, exercises actual IndexedDB/CryptoKey cloning, and checks that persisted records contain no plaintext peer secrets. |

## Prioritized follow-up

1. Add the existing two-instance mesh pytest file to a dedicated durable E2E CI command.
2. Refactor WebRTC browser scenario assertions into a reusable Playwright Test helper/spec while keeping shell/Docker launchers.
3. Add focused pytest coverage for the deterministic pieces inside `webrtc_interop_gateway.py`.
4. Optionally add shell-level failure/cleanup tests for missing Docker/browser binaries. This is lower value than the three items above because the live workflow already exercises the happy path and fails on nonzero exits.
