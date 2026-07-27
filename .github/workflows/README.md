# Aurora GitHub Actions

Current durable workflow lanes:

- `quality.yml` — Ruff, generated config, TypeScript typechecks.
- `python-tests.yml` — consolidated unit, integration, Redis-backed process-mode, and Python E2E tests, including both mesh harnesses.
- `frontend-sdk.yml` — SDK/UI/web/Tauri-frontend tests and builds.
- `webrtc-interop.yml` — one live-interoperability check covering encrypted browser persistence plus the cross-engine direct/STUN/TURN matrix.
- `sdk-backend-contract-conformance.yml` — backend inventory and SDK fixture/type conformance.
- `tauri-desktop.yml` — desktop-local sidecar and Python-free desktop-thin build/runtime checks.
- `tauri-android.yml` — one Android check for Python-free APK/AAB proof, API 30 UI/native payload smoke, and API 35 packaged-WebView ↔ external Python peer WebRTC interop.
- `tauri-ios.yml`, `tauri-ios-release.yml` — macOS simulator build/runtime smoke and the separate signing-policy lane.
- `performance.yml` — manual/scheduled performance and resilience checks.
- `docker-build.yml` — per-service container image matrix.
- `release.yml` — manual semantic-release publication.
- `required-check-aliases.yml` — temporary low-cost aliases for stale branch-protection contexts; remove after GitHub required checks are updated to canonical workflow/job names.

See `docs/CI_CD.md` for local command equivalents and artifact policy.
