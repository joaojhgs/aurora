# PER-223 Multi-Mode E2E Matrix Plan

## Source Of Truth

- Multica PER-223 / QA-002 acceptance criteria.
- `.omx/specs/ui-production-tasks/tasks/QA-002-build-multi-mode-e2e-matrix.md`.
- `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`.
- `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md`.
- `.omx/specs/mesh-ui-roadmap-integration-review.md`.
- `tests/AGENTS.md`, `.github/workflows/*.yml`, `docs/MESH_GAP_E2E_HARNESS.md`.

## Scope

Create a production gate artifact for the UI/backend/native matrix without adding unrelated production UI wiring. The gate must document commands, workflow jobs, artifacts, owners, security/privacy negative cases, and explicit manual device-lab deferrals.

## Implementation Steps

1. Add `scripts/multi_mode_e2e_matrix.py` to generate JSON and Markdown release evidence under `.omx/reports/multi-mode-e2e/latest/`.
2. Add pytest coverage in `tests/e2e/test_multi_mode_e2e_matrix.py` for required modes, addendum scenarios, negative security/privacy coverage, artifact/runbook fields, and no mock-only production claims.
3. Update `.github/workflows/test-e2e.yml` so CI runs the existing mesh harness, the new matrix report/tests, and frontend SDK/UI/web smoke commands, then uploads both mesh and matrix artifacts.
4. Add `docs/MULTI_MODE_E2E_RELEASE_RUNBOOK.md` with install, update, backup, diagnostics, rollback, CI command, artifact, and manual device-lab guidance.
5. Verify with targeted pytest, generator execution, package tests/typechecks where available, and YAML syntax compilation.

## Acceptance Criteria

- Matrix includes server web, desktop thin, desktop local, mesh shell, Android thin, and iOS thin rows.
- Matrix includes thread/local, process/Redis, HTTP server, Tauri local, and mesh/WebRTC runtime evidence where supported.
- Mesh addendum scenarios include local-only tool, remote-only tool, duplicated local+remote provider selector, dangerous local approval, dangerous remote approval, approve-all, expired approval, denied replay, remote RAG, remote STT consent/events, scheduler delegation, route explain, and diagnostics/audit support bundle.
- Security/privacy cases include negative auth/config mutation, approval replay/mismatch/missing token, missing namespace, missing consent, raw secret redaction, and mock-transport release protection.
- Release runbook covers install, update, backup, diagnostics, rollback, artifact collection, and manual device lab limits.
- Physical/OEM-only mobile evidence is not marked production complete by emulator-only CI.

## Verification

- `uv run python scripts/multi_mode_e2e_matrix.py --output-dir /tmp/per223-matrix`
- `uv run pytest tests/e2e/test_multi_mode_e2e_matrix.py -q`
- `uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py tests/e2e/test_multi_mode_e2e_matrix.py -q`
- `python -m py_compile scripts/multi_mode_e2e_matrix.py tests/e2e/test_multi_mode_e2e_matrix.py`
- `pnpm --filter @aurora/client test`
- `pnpm --filter @aurora/ui test`
- `pnpm --filter @aurora/web test`
- `git diff --check`

## Risks

- Device-lab evidence cannot be produced on GitHub-hosted Linux alone. Mitigation: mark physical Android assistant-role/OEM and iOS real-device rows as manual release blockers until artifacts are attached.
- Mock transport can accidentally look green. Mitigation: generated matrix treats mock fixtures as fixture-only and tests assert no production row claims mock-only proof.
- Existing mesh process row can require Redis. Mitigation: reuse the MESH-GAP-011 harness status and record dependency gaps as non-final evidence.
