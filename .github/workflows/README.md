# Aurora GitHub Actions

Current durable workflow lanes:

- `quality.yml` — Ruff, generated config, TypeScript typechecks.
- `python-tests.yml` — consolidated unit, integration, Redis-backed process-mode, and Python E2E tests, including both mesh harnesses.
- `frontend-sdk.yml` — SDK/UI/web/Tauri-frontend tests and builds.
- `webrtc-interop.yml` — one live-interoperability check covering encrypted browser persistence plus the cross-engine direct/STUN/TURN matrix.
- `sdk-backend-contract-conformance.yml` — backend inventory and SDK fixture/type conformance.
- `tauri-desktop.yml` — desktop-local sidecar and Python-free desktop-client build/runtime checks, including separate Linux AppImage/DEB/RPM artifacts.
- `tauri-android.yml` — one Android check for Python-free APK/AAB proof, API 30 UI/native payload smoke, and API 35 packaged-System-WebView plus standalone-mobile-browser ↔ external Python peer WebRTC interop.
- `tauri-ios.yml`, `tauri-ios-release.yml` — one macOS simulator build/runtime/MobileSafari ↔ external-Python WebRTC check plus the separate signing-policy lane.
- `performance.yml` — manual/scheduled performance and resilience checks.
- `docker-build.yml` — per-service container image matrix.
- `release.yml` — manual semantic-release publication with pre-tag package-set validation, standalone web/server archives, and checksummed canonical assets.
- `required-check-aliases.yml` — temporary aliases for stale branch-protection contexts; each alias waits for the matching canonical job and fails unless that job succeeded. Remove after GitHub required checks are updated to canonical workflow/job names.

See `docs/CI_CD.md` for local command equivalents and artifact policy.
