# Aurora GitHub Actions

Current durable workflow lanes:

- `quality.yml` — Ruff, generated config, TypeScript typechecks.
- `python-tests.yml` — unit, integration, and Redis-backed process-mode tests.
- `e2e.yml` — mesh transport E2E harness.
- `frontend-sdk.yml` — SDK/UI/web tests and builds.
- `sdk-backend-contract-conformance.yml` — backend inventory and SDK fixture/type conformance.
- `tauri-desktop.yml`, `tauri-android.yml`, `tauri-ios.yml`, `tauri-ios-release.yml` — desktop/mobile Tauri checks.
- `performance.yml` — manual/scheduled performance and resilience checks.
- `docker-build.yml` — per-service container image matrix.
- `release.yml` — manual semantic-release publication.

See `docs/CI_CD.md` for local command equivalents and artifact policy.
