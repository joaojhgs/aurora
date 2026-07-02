# CI/CD Workflows

Aurora CI is organized around durable product lanes rather than one-off issue gates. Local commands and GitHub Actions should use the same package scripts where possible.

## Required CI lanes

| Workflow | Purpose | Main checks |
| --- | --- | --- |
| `quality.yml` | Fast static feedback. | Generated config check, docs hygiene, Ruff lint/format, TypeScript typechecks. |
| `python-tests.yml` | Backend unit/integration coverage. | Unit tests, non-process integration tests, Redis-backed process-mode integration tests. |
| `e2e.yml` | Executable cross-surface E2E evidence. | Mesh transport harness and redacted support-bundle artifacts. |
| `frontend-sdk.yml` | TypeScript SDK, shared UI, and web app. | SDK tests/build, UI tests/build, accessibility/responsive/visual suite, web app tests/build. |
| `sdk-backend-contract-conformance.yml` | Backend/SDK contract drift protection. | Generated backend inventory, SDK fixture/type conformance, SDK package checks. |
| `tauri-desktop.yml` | Desktop Tauri shell and sidecar packaging smoke. | Thin sidecar preparation, Rust check, Linux bundle, EventStream smoke, sidecar profile matrix. |
| `tauri-android.yml` | Android build and emulator smoke. | Android init, unsigned CI preflight, x86_64 debug APK, emulator native payload smoke. |
| `tauri-ios.yml` | iOS simulator baseline. | Tauri iOS init/build and Swift smoke tests for native entrypoints. |
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
uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py -q
uv run pytest tests/performance -v

# TypeScript packages
pnpm install --frozen-lockfile
pnpm --filter @aurora/client test && pnpm --filter @aurora/client build
pnpm --filter @aurora/client test:resilience
pnpm --filter @aurora/ui test && pnpm --filter @aurora/ui test:accessibility && pnpm --filter @aurora/ui build
pnpm --filter @aurora/web test && pnpm --filter @aurora/web build

# Tauri desktop profiles
pnpm --filter @aurora/tauri-ui prepare:sidecar:thin
pnpm --filter @aurora/tauri-ui build:bundle:thin
pnpm --filter @aurora/tauri-ui prepare:sidecar:local-cpu
```

## Branch protection compatibility

GitHub branch protection can keep expecting old check names after workflow consolidation. `required-check-aliases.yml` is intentionally tiny and should be removed after the required checks are updated in repository settings to the canonical lanes above:

- `Quality / Python lint, format, and generated config`
- `Python Tests / Unit and integration tests`
- `Python Tests / Process-mode integration tests`

## What was intentionally removed

The repository no longer keeps one-off issue-specific gate generator workflows for release packaging, transport parity, multi-mode matrix generation, security/privacy report generation, or UI release preflight. Useful coverage from those scripts was preserved as normal tests, package scripts, or durable workflows above.

## Artifact policy

- Normal test evidence goes under package-local `reports/`, `tests/**/reports/`, or `.artifacts/**`.
- `.omx/**` is reserved for agent/workflow state, not CI artifacts.
- CI may upload redacted reports and support bundles; it must not upload raw tokens, Redis URLs, API keys, unredacted mesh credentials, raw audio, or raw RAG records.

## Release and signing policy

Default desktop/mobile CI builds are unsigned and intended for validation only. Android pull-request CI uses `android:preflight:ci` after `android:init`: it requires the generated Android project but does not require keystore secrets. Package signing, notarization, App Store Connect, and Play upload remain explicit release operations requiring platform secrets; Android release readiness uses `android:preflight:strict`.
