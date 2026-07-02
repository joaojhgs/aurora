Consolidate Aurora CI/CD, test scripts, and release gates into a durable production-grade shape.

Target result:
- Remove or archive issue-specific PER/QA gate/report-generator workflows and scripts that only create .omx report artifacts or stale release checklists.
- Preserve useful behavior by converting it into normal tests, package scripts, or clear CI jobs.
- CI should be organized around actual durable lanes: lint/format/generated-config checks, Python unit tests, integration tests, e2e tests, process-mode Redis tests, frontend/SDK checks, Tauri desktop/mobile verification, SDK/backend conformance, Docker build validation, performance/benchmarks, and release packaging where real.
- Remove stale workflow clutter and misleading names, especially release-packaging operator gates, transport parity gates, PER/QA matrix/preflight report generators, and tests that only assert generated report shape.
- Keep useful build/developer scripts such as sidecar preparation, backend inventory/conformance, process-mode/docker/Tilt helpers, and real smoke tests.
- Update docs to describe simple standard local and CI commands.
- Preserve existing smart Tauri sidecar packaging work and avoid package signing scope.

Constraints:
- Do not delete normal unit/integration/e2e/performance tests for real behavior.
- Do not weaken architecture rules: services communicate by bus, typed contracts remain source of truth, generated config artifacts stay checked.
- Do not add new dependencies unless strictly necessary.
- Verify with targeted lint/tests and YAML/package script sanity checks.
