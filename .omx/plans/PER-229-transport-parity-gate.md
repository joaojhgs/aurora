# PER-229 / QA-008 Transport Parity Gate Plan

## Requirements Summary

- Source of truth: Multica PER-229 / QA-008 and `.omx/specs/ui-production-tasks/tasks/QA-008-build-thread-process-mesh-transport-parity-gate.md`.
- Relevant guidance read: root `AGENTS.md`, `tests/AGENTS.md`, `app/messaging/AGENTS.md`, `app/services/gateway/AGENTS.md`, `app/shared/AGENTS.md`, `app/shared/contracts/AGENTS.md`.
- UI/SDK context read: `.omx/specs/ui-refinement/*`, `.omx/specs/ui-production-tasks/index.md`, `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`, `.omx/specs/mesh-ui-roadmap-integration-review.md`, `modules/ui-mock-reference/README.md`, `modules/ui-mock-reference/lib/aurora/data.ts`, and `modules/ui-mock-reference/components/aurora/assistant/route-sheet.tsx`.
- Existing evidence to reuse: `scripts/mesh_gap_e2e_harness.py`, `tests/e2e/test_mesh_gap_e2e_harness.py`, and `packages/aurora-sdk/tests/conformance.test.ts`.

## Acceptance Criteria

- Emit a single QA-008 matrix artifact with rows for thread/local, process/Redis, server HTTP, desktop Tauri local, mesh/WebRTC, Android thin/local-light, and iOS thin/local-light.
- Every row records pass/fail/skipped-with-rationale, owner, command(s), artifact path(s), and coverage claims.
- The gate must not pass on mock-only SDK evidence: live/hermetic transport rows and SDK/UI command evidence are tracked separately, and missing live evidence blocks release readiness.
- Process/Redis, Android, and iOS environment gaps are explicit skipped/blocked rows with the exact command needed to produce evidence.
- Artifacts redact Redis URLs, local host paths, tokens, peer secrets, and secret-like diagnostics.

## Implementation Steps

1. Add `scripts/transport_parity_gate.py` as the QA-008 release wrapper around the existing two-peer harness and SDK/UI command evidence.
2. Add e2e tests for matrix shape, row status semantics, redaction, and "mock evidence alone cannot pass".
3. Add a concise runbook for local/CI execution and artifact expectations.
4. Add a GitHub Actions workflow/manual gate entry if the repo does not already have a QA-008 workflow.
5. Verify targeted Python tests and run the lightest available SDK/UI commands locally.

## Risks And Mitigations

- Redis/Docker/mobile runners may be unavailable locally. Mitigation: mark rows `skipped-with-rationale`, keep `blocks_release=true`, and record exact commands/follow-up evidence.
- Mock SDK tests can hide transport failures. Mitigation: the report has separate `mock_only_evidence_passed` and `release_ready` fields; release readiness requires real/hermetic transport rows.
- Secrets can leak through diagnostics. Mitigation: reuse the mesh harness redaction posture and add release-gate redaction tests.

## Verification Steps

- `uv run pytest tests/e2e/test_transport_parity_gate.py -q`
- `uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py -q`
- `pnpm --filter @aurora/client build`
- `pnpm --filter @aurora/client test`
- `pnpm --filter @aurora/ui test`
- `pnpm --filter @aurora/tauri-ui test`

## Stop Rule

Hand off to QA when the report generator, tests, docs/workflow, and local verification are committed and a PR exists. Do not trigger the batch-tail autopilot until QA and architect gates complete for PER-227 and PER-229.
